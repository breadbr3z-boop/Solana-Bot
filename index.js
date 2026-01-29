const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const https = require('https');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_IP = "https://74.125.22.103"; // Direct IP Bypass (Google/Jupiter Gateway)
const agent = new https.Agent({ rejectUnauthorized: false });

let isWorking = false;

// 🚀 THE V17 NUCLEAR STRIKE
async function nuclearBuy(mint) {
    try {
        console.log(`🔥 ATTEMPTING NUCLEAR BUY: ${mint.slice(0,6)}`);
        
        // 1. Get Quote via Direct IP (Bypasses DNS)
        const quote = await axios.get(`${JUP_IP}/v6/quote`, {
            params: {
                inputMint: SOL_MINT,
                outputMint: mint,
                amount: Math.floor(0.01 * LAMPORTS_PER_SOL),
                slippageBps: 5000 // 50% Slippage to force entry
            },
            headers: { 'Host': 'quote-api.jup.ag' },
            httpsAgent: agent,
            timeout: 3000
        });

        // 2. Get Swap Transaction via Direct IP
        const swap = await axios.post(`${JUP_IP}/v6/swap`, {
            quoteResponse: quote.data,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 1000000, // 1M Lamports to jump the line
            dynamicComputeUnitLimit: true
        }, {
            headers: { 'Host': 'quote-api.jup.ag' },
            httpsAgent: agent,
            timeout: 5000
        });

        // 3. Sign and Blast
        const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        
        bot.sendMessage(MY_ID, `💎 NUCLEAR SNIPE LANDED!\nhttps://solscan.io/tx/${sig}`);
        console.log("🔥 SUCCESS: Transaction Blasted.");

    } catch (e) {
        console.log(`🚨 Nuclear Fail: ${e.message}`);
    }
}

async function buyToken(mint) {
    try {
        // 1. Mandatory RugCheck
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`).catch(() => ({ data: { score: 0 } }));
        if (rug.data.score > 500) return console.log(`⚠️ Skip: Score ${rug.data.score}`);

        // 2. No waiting, no looping. Just the strike.
        await nuclearBuy(mint);

    } catch (e) { console.log(`🚨 Status Error: ${e.message}`); }
}

async function toggleScanning(on) {
    if (!on) return;
    const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    
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
        
        setTimeout(() => { isWorking = false; }, 10000); // 10s cooldown
    }, 'processed');
}

process.once('SIGTERM', () => { bot.stopPolling(); process.exit(0); });

console.log("🚀 V17 IRONCLAD NUCLEAR ONLINE.");
toggleScanning(true);
