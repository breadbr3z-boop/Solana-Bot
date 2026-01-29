const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. SMART CONNECTION
const connection = new Connection(process.env.RPC_URL, { 
    wsEndpoint: process.env.WSS_URL, 
    commitment: 'confirmed' 
});

const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";

let isBusy = false; // The single-processing lock

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// 2. INTERNAL SAFETY (Local Authority Check)
async function isLocallySafe(mint) {
    try {
        const info = await connection.getParsedAccountInfo(new PublicKey(mint));
        return info.value?.data.parsed.info.mintAuthority === null;
    } catch (e) { return false; }
}

// 3. BUYER (Optimized)
async function buyToken(mint) {
    try {
        const quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: (0.01 * LAMPORTS_PER_SOL).toString(), slippageBps: 5000 });
        if (!quote) return;
        const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" } });
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `🚀 SNIPE! https://solscan.io/tx/${sig}`);
    } catch (e) { console.log("🚨 Buy Fail"); }
}

// 4. THE FILTERED SCANNER
[RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
    connection.onLogs(pId, async ({ logs, signature, err }) => {
        // FILTER 1: Skip if busy or wrong log type
        if (err || isBusy || !logs.some(l => l.toLowerCase().includes("init"))) return;

        isBusy = true; // LOCK the scanner
        console.log(`💎 SIGNAL: ${signature.slice(0, 8)}...`);

        try {
            let tx = null;
            for (let i = 0; i < 5; i++) {
                tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
                if (tx) break;
                await delay(2000);
            }
            if (!tx) { isBusy = false; return; }

            const allAccounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
            let mint = null;
            for (const addr of allAccounts) {
                if (addr !== SOL_MINT && addr !== pId.toBase58() && addr !== wallet.publicKey.toBase58() && !addr.startsWith('1111') && !addr.startsWith('Tokenkeg')) {
                    mint = addr;
                    break; 
                }
            }

            if (mint) {
                console.log(`🎯 TARGET: ${mint.slice(0, 8)}`);
                try {
                    const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 3000 });
                    if (rug.data.score < 5000) {
                        await buyToken(mint);
                        await delay(60000); // 1-minute cooldown after successful buy
                    }
                } catch (e) {
                    console.log(`⚠️ RugCheck Busy. Checking ${mint.slice(0,4)} Internally...`);
                    if (await isLocallySafe(mint)) {
                        console.log(`✅ Safe! Buying ${mint.slice(0,4)}`);
                        await buyToken(mint);
                        await delay(60000);
                    }
                }
            }
        } catch (e) { }
        
        isBusy = false; // UNLOCK the scanner
    }, 'processed');
});

// GLOBAL ERROR CATCH
process.on('uncaughtException', (err) => {
    if (err.message.includes('429')) console.log('🛑 429 Catch: Throttling back...');
    else console.error('💥 Critical:', err);
});

console.log("🚀 FILTERED APEX LIVE.");
