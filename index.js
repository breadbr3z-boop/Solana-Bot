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
let isPaused = false;

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// 1. AUTO-SELL (Watchdog)
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
                const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                bot.sendMessage(MY_ID, `🎯 EXIT: ${price >= entryPrice * 1.5 ? "TP" : "SL"} | https://solscan.io/tx/${sig}`);
            }
        } catch (e) { }
    }, 15000);
}

// 2. THE BUYER
async function buyToken(mint) {
    try {
        const quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: (0.01 * LAMPORTS_PER_SOL).toString(), slippageBps: 5000 });
        if (!quote) return;
        const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" } });
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `🚀 SNIPE SUCCESS! https://solscan.io/tx/${sig}`);
        monitorPrice(mint, (0.01 * LAMPORTS_PER_SOL) / parseFloat(quote.outAmount), quote.outAmount);
    } catch (e) { }
}

// 3. THE "STRICT 2000" SCANNER
[RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
    connection.onLogs(pId, async ({ logs, signature, err }) => {
        // 📉 JITTER-SKIP + TRAFFIC FILTER
        if (Math.random() > 0.3 || err || isPaused || !logs.some(l => l.toLowerCase().includes("init"))) return;

        (async () => {
            console.log(`💎 SIGNAL: ${signature.slice(0, 8)}`);
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
            if (!tx) return;

            const allAccounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
            let mint = allAccounts.find(addr => 
                addr !== SOL_MINT && addr !== pId.toBase58() && addr !== wallet.publicKey.toBase58() && 
                !addr.startsWith('1111') && !addr.startsWith('Tokenkeg')
            );

            if (mint) {
                try {
                    const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 4000 });
                    const score = rug.data.score;
                    
                    // 🎯 UPDATED SCORE FILTER: 2000
                    if (score < 2000) {
                        console.log(`✅ QUALITY MATCH: ${mint.slice(0,4)} (Score: ${score})`);
                        isPaused = true;
                        await buyToken(mint);
                        setTimeout(() => isPaused = false, 60000);
                    } else {
                        console.log(`⚠️ REJECTED: ${mint.slice(0,4)} score too high (${score})`);
                    }
                } catch (e) {
                    // Fallback to internal check if RugCheck is busy
                    const info = await connection.getAccountInfo(new PublicKey(mint)).catch(() => null);
                    if (info) {
                        console.log(`⚠️ RugCheck Busy. Internal Pass for ${mint.slice(0,4)}`);
                        isPaused = true;
                        await buyToken(mint);
                        setTimeout(() => isPaused = false, 60000);
                    }
                }
            }
        })(); 
    }, 'processed');
});

console.log("🚀 STRICT APEX (SCORE 2000) LIVE.");
