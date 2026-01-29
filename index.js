const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const SOL_MINT = "So11111111111111111111111111111111111111112";

// 🌐 THE RELIABLE PATHS
const JUP_LINKS = [
    "https://quote-api.jup.ag/v6",
    "https://public.jupiterapi.com/v6" // Mirror for failover
];

let isWorking = false;

async function nuclearBuy(mint) {
    console.log(`🔥 STRIKING: ${mint.slice(0,6)}`);
    
    for (let link of JUP_LINKS) {
        try {
            // 1. GET QUOTE
            const quote = await axios.get(`${link}/quote`, {
                params: { inputMint: SOL_MINT, outputMint: mint, amount: Math.floor(0.01 * LAMPORTS_PER_SOL), slippageBps: 5000 },
                timeout: 3000
            });

            // 2. GET SWAP
            const swap = await axios.post(`${link}/swap`, {
                quoteResponse: quote.data,
                userPublicKey: wallet.publicKey.toBase58(),
                wrapAndUnwrapSol: true,
                prioritizationFeeLamports: 1000000,
                dynamicComputeUnitLimit: true
            }, { timeout: 4000 });

            // 3. BLAST
            const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
            tx.sign([wallet]);
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
            
            bot.sendMessage(MY_ID, `💎 NUCLEAR SNIPE LANDED!\nhttps://solscan.io/tx/${sig}`);
            return; // Exit if successful

        } catch (e) {
            console.log(`🔄 Path ${link.includes('jup.ag') ? 'Primary' : 'Mirror'} failed, trying next...`);
        }
    }
    console.log("🚨 All paths exhausted. Coin likely too new for Jupiter.");
}

async function buyToken(mint) {
    try {
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 4000 }).catch(() => ({ data: { score: 0 } }));
        if (rug.data.score > 500) return console.log(`⚠️ Skip: Score ${rug.data.score}`);
        await nuclearBuy(mint);
    } catch (e) { console.log(`🚨 Error: ${e.message}`); }
}

async function toggleScanning(on) {
    if (!on) return;
    const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    
    connection.onLogs(RAYDIUM_V4, async ({ signature, logs, err }) => {
        if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;
        isWorking = true;
        
        try {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx && tx.meta.postTokenBalances) {
                const mint = tx.meta.postTokenBalances.find(b => b.mint !== SOL_MINT && b.owner !== RAYDIUM_V4.toBase58())?.mint;
                if (mint) await buyToken(mint);
            }
        } catch (e) { }
        
        setTimeout(() => { isWorking = false; }, 10000); 
    }, 'processed');
}

process.once('SIGTERM', () => { bot.stopPolling(); process.exit(0); });

console.log("🚀 V18 HYBRID NUCLEAR ONLINE.");
toggleScanning(true);
