const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

// 🔗 BYPASS ENDPOINTS (Using multiple providers to ensure one hits)
const JUP_ENDPOINTS = [
    "https://quote-api.jup.ag/v6",
    "https://jup.ag/api/v6",
    "https://api.jup.ag/v6"
];

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function strike(mint) {
    console.log(`[${new Date().toLocaleTimeString()}] 🛰️ INITIATING BYPASS STRIKE: ${mint}`);
    
    let quote = null;
    let successfulEndpoint = "";

    // 🔄 TRY EVERY ENDPOINT UNTIL DNS RESOLVES
    for (const endpoint of JUP_ENDPOINTS) {
        try {
            const res = await axios.get(`${endpoint}/quote`, {
                params: { inputMint: SOL_MINT, outputMint: mint, amount: 0.01 * LAMPORTS_PER_SOL, slippageBps: 5000, onlyDirectRoutes: true },
                timeout: 3000
            });
            if (res.data) {
                quote = res.data;
                successfulEndpoint = endpoint;
                break;
            }
        } catch (e) {
            console.log(`❌ ${endpoint} failed: ${e.code || 'Timeout'}`);
        }
    }

    if (!quote) {
        return console.log("🚨 ALL ENDPOINTS BLOCKED BY RAILWAY DNS.");
    }

    try {
        const { data: swap } = await axios.post(`${successfulEndpoint}/swap`, {
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            prioritizationFeeLamports: 5000000,
            wrapAndUnwrapSol: true
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
        tx.sign([wallet]);

        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `🔥 BYPASS SUCCESS!\nTX: https://solscan.io/tx/${sig}`);
        console.log(`✅ SENT: ${sig}`);
    } catch (e) {
        console.log(`🚨 SWAP ERROR: ${e.message}`);
    }
}

async function main() {
    console.log("🚀 V34 IRON-CURTAIN ONLINE.");
    const RAY_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    
    connection.onLogs(RAY_V4, async ({ signature, logs, err }) => {
        if (err || !logs.some(l => l.toLowerCase().includes("init"))) return;
        
        try {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            const mint = tx?.meta?.postTokenBalances?.find(b => b.mint !== SOL_MINT && b.owner !== RAY_V4.toBase58())?.mint;
            if (mint) await strike(mint);
        } catch (e) { }
    }, 'processed');
}

main();
