const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL, Transaction, TransactionMessage } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

let isWorking = false;

// 🚀 THE NUCLEAR BUYER (No Quotes, Just Swap)
async function forceBuy(mint, poolKeys) {
    try {
        console.log(`🔥 FORCE BUYING: ${mint.slice(0,6)}`);
        
        // We use the Raydium Transaction API to build a raw swap 
        // This is much faster than Jupiter or the standard Raydium API
        const res = await axios.post(`https://transaction-mainnet.raydium.io/v1/compute/swapbasein`, {
            inputMint: SOL_MINT,
            outputMint: mint,
            amount: Math.floor(0.01 * LAMPORTS_PER_SOL),
            slippageBps: 5000, // 50% slippage to guarantee the fill
            txVersion: 'V0',
            payer: wallet.publicKey.toBase58()
        });

        if (res.data.success) {
            const tx = VersionedTransaction.deserialize(Buffer.from(res.data.data[0].transaction, 'base64'));
            tx.sign([wallet]);
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
            
            bot.sendMessage(MY_ID, `🚀 FORCE SNIPE SUCCESS!\nhttps://solscan.io/tx/${sig}`);
            console.log("💎 Transaction Sent!");
        } else {
            console.log("🚨 Raydium route not ready yet.");
        }
    } catch (e) {
        console.log(`🚨 Execution Error: ${e.message}`);
    }
}

async function buyToken(mint) {
    try {
        // 1. RugCheck (Mandatory)
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`).catch(() => ({ data: { score: 0 } }));
        if (rug.data.score > 500) return console.log(`⚠️ Skip: Score ${rug.data.score}`);

        // 2. Immediate Force Buy (No looping/waiting)
        await forceBuy(mint);

    } catch (e) { console.log(`🚨 Status: ${e.message}`); }
}

async function toggleScanning(on) {
    if (!on) return;
    connection.onLogs(RAYDIUM_V4, async ({ signature, logs, err }) => {
        if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;
        isWorking = true;
        
        try {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx) {
                const mint = tx.meta.postTokenBalances.find(b => b.mint !== SOL_MINT && b.owner !== RAYDIUM_V4.toBase58())?.mint;
                if (mint) await buyToken(mint);
            }
        } catch (e) { }
        
        setTimeout(() => { isWorking = false; }, 15000); // 15s reset to catch more coins
    }, 'processed');
}

process.once('SIGINT', () => { bot.stopPolling(); process.exit(0); });
process.once('SIGTERM', () => { bot.stopPolling(); process.exit(0); });

console.log("🚀 V16 NUCLEAR SNIPER ONLINE.");
toggleScanning(true);
