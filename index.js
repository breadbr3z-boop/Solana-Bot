const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";

// 🛡️ THE GLOBAL LOCK
let isWorking = false; 

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// 1. AUTO-SELL MONITOR
async function monitorPrice(mint, entryPrice, tokens) {
    const watchdog = setInterval(async () => {
        try {
            const quote = await jupiter.quoteGet({ inputMint: mint, outputMint: SOL_MINT, amount: tokens.toString(), slippageBps: 100 });
            const price = parseFloat(quote.outAmount) / tokens;
            if (price >= entryPrice * 1.5 || price <= entryPrice * 0.7) {
                clearInterval(watchdog);
                const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" } });
                const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
                tx.sign([wallet]);
                await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                bot.sendMessage(MY_ID, `🎯 EXIT SUCCESS: ${price >= entryPrice * 1.5 ? "TP" : "SL"}`);
            }
        } catch (e) { }
    }, 20000);
}

// 2. THE BUYER (With Crash-Protection)
async function buyToken(mint) {
    try {
        const quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: (0.01 * LAMPORTS_PER_SOL).toString(), slippageBps: 5000 });
        if (!quote) return;
        const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" } });
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `🚀 SNIPE BOUGHT! https://solscan.io/tx/${sig}`);
        monitorPrice(mint, (0.01 * LAMPORTS_PER_SOL) / parseFloat(quote.outAmount), quote.outAmount);
    } catch (e) { console.log("🚨 Buy Execution Error"); }
}

// 3. THE "DEEP-FREEZE" SCANNER
[RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
    connection.onLogs(pId, async ({ logs, signature, err }) => {
        // 🔒 HARD LOCK: If bot is doing ANYTHING, ignore everything else.
        if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;

        isWorking = true; // Lock the gates
        console.log(`💎 SIGNAL DETECTED: ${signature.slice(0, 8)}`);

        try {
            let tx = null;
            for (let i = 0; i < 4; i++) {
                tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
                if (tx) break;
                await delay(3000);
            }
            if (!tx) throw new Error("Parse Timeout");

            const allAccounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
            let mint = allAccounts.find(addr => 
                addr !== SOL_MINT && addr !== pId.toBase58() && addr !== wallet.publicKey.toBase58() && 
                !addr.startsWith('1111') && !addr.startsWith('Tokenkeg')
            );

            if (mint) {
                console.log(`🎯 TARGET: ${mint.slice(0, 8)}`);
                try {
                    const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 4000 });
                    if (rug.data.score < 2000) {
                        await buyToken(mint);
                        await delay(60000); 
                    }
                } catch (e) {
                    console.log(`⚠️ RugCheck Busy. Checking ${mint.slice(0,4)} Internally...`);
                    const info = await connection.getAccountInfo(new PublicKey(mint)).catch(() => null);
                    if (info && info.owner.toBase58().includes('Token')) {
                        console.log(`✅ INTERNAL PASS: ${mint.slice(0,4)}`);
                        await buyToken(mint);
                        await delay(60000);
                    }
                }
            }
        } catch (e) { console.log("🛑 Scan Interrupted/Failed"); }
        
        isWorking = false; // Unlock the gates
    }, 'processed');
});

process.on('uncaughtException', (err) => { console.log('🛡️ Blocked Crash:', err.message); isWorking = false; });

console.log("🚀 BULLETPROOF APEX LIVE.");
