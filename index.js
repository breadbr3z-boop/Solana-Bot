const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";
let isPaused = false;

// 1. INTERNAL SAFETY CHECK (Bypasses RugCheck if busy)
async function isLocallySafe(mint) {
    try {
        const info = await connection.getParsedAccountInfo(new PublicKey(mint));
        // If mint authority is null, they can't print more tokens (Good sign)
        const isMintLocked = info.value?.data.parsed.info.mintAuthority === null;
        return isMintLocked;
    } catch (e) { return false; }
}

// 2. BUYER & MONITOR (Condensed for speed)
async function buyToken(mint) {
    const start = Date.now();
    let quote = null;
    while (Date.now() - start < 30000) {
        try {
            quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: (0.01 * LAMPORTS_PER_SOL).toString(), slippageBps: 5000 });
            if (quote) break;
        } catch (e) { await new Promise(r => setTimeout(r, 1500)); }
    }
    if (!quote) return;
    try {
        const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" } });
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `🚀 BUY SUCCESS: https://solscan.io/tx/${sig}`);
    } catch (e) { }
}

// 3. THE "NEVER-DROP" SCANNER
[RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
    connection.onLogs(pId, async ({ logs, signature, err }) => {
        if (err || isPaused || !logs.some(l => l.toLowerCase().includes("init"))) return;

        (async () => {
            let tx = null;
            for (let i = 0; i < 5; i++) {
                tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                if (tx) break;
                await new Promise(r => setTimeout(r, 2000));
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
                    // Try RugCheck with a short timeout
                    const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 4000 });
                    if (rug.data.score < 5000) {
                        isPaused = true;
                        await buyToken(mint);
                        setTimeout(() => { isPaused = false; }, 60000);
                    }
                } catch (e) {
                    console.log(`⚠️ RugCheck Busy. Running Internal Scan for ${mint.slice(0,4)}...`);
                    const safe = await isLocallySafe(mint);
                    if (safe) {
                        console.log(`✅ Internal Scan Passed! Buying.`);
                        isPaused = true;
                        await buyToken(mint);
                        setTimeout(() => { isPaused = false; }, 60000);
                    }
                }
            }
        })(); 
    }, 'processed');
});
console.log("🚀 APEX BYPASS SYSTEM LIVE.");
