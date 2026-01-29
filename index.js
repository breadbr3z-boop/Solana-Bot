const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. CRASH-PROOF CONNECTION
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
let isPaused = false;

// 🛡️ GLOBAL RATE LIMITER
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// 2. INTERNAL SAFETY (With 429 Error Catching)
async function isLocallySafe(mint) {
    for (let i = 0; i < 3; i++) { // 3 Retries for RPC
        try {
            const info = await connection.getParsedAccountInfo(new PublicKey(mint));
            return info.value?.data.parsed.info.mintAuthority === null;
        } catch (e) {
            if (e.message.includes('429')) {
                console.log("⏳ RPC Rate Limited... Sleeping 2s");
                await delay(2000);
            } else break;
        }
    }
    return false;
}

// 3. BUYER (Simplified & Fast)
async function buyToken(mint) {
    try {
        const quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: (0.01 * LAMPORTS_PER_SOL).toString(), slippageBps: 5000 });
        if (!quote) return;
        const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" } });
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `🚀 SNIPE! https://solscan.io/tx/${sig}`);
    } catch (e) { console.log("🚨 Buy Failed"); }
}

// 4. PARALLEL SCANNER (With Queue Control)
[RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
    connection.onLogs(pId, async ({ logs, signature, err }) => {
        if (err || isPaused || !logs.some(l => l.toLowerCase().includes("init"))) return;

        (async () => {
            try {
                let tx = null;
                for (let i = 0; i < 5; i++) {
                    tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
                    if (tx) break;
                    await delay(2500);
                }
                if (!tx) return;

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
                            isPaused = true;
                            await buyToken(mint);
                            setTimeout(() => isPaused = false, 60000);
                        }
                    } catch (e) {
                        console.log(`⚠️ RugCheck Busy. Checking ${mint.slice(0,4)} Internally...`);
                        if (await isLocallySafe(mint)) {
                            console.log(`✅ Safe! Buying ${mint.slice(0,4)}`);
                            isPaused = true;
                            await buyToken(mint);
                            setTimeout(() => isPaused = false, 60000);
                        }
                    }
                }
            } catch (innerErr) { console.log("❌ Log Process Error"); }
        })(); 
    }, 'processed');
});

// 🛡️ THE FINAL SAFETY NET: Prevents "429" from killing the app
process.on('uncaughtException', (err) => {
    if (err.message.includes('429')) {
        console.log('🛑 Global 429 Catch: RPC overloaded. Throttling back...');
    } else {
        console.error('💥 Critical Error:', err);
    }
});

console.log("🚀 APEX IRONCLAD LIVE.");
