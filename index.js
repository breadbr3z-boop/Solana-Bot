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

// 🌐 THE REINFORCED ENDPOINTS
const SWAP_ENDPOINTS = [
    "https://api-v3.raydium.io/main/swap", 
    "https://api.raydium.io/v2/main/quote" 
];

let isWorking = false;

async function directStrike(mint) {
    console.log(`⚡ STRIKE INITIATED: ${mint.slice(0,6)}`);
    
    for (let endpoint of SWAP_ENDPOINTS) {
        try {
            // Using the Raydium V3 style which is more robust against DNS blocks
            const res = await axios.post(endpoint, {
                inputMint: SOL_MINT,
                outputMint: mint,
                amount: Math.floor(0.01 * LAMPORTS_PER_SOL),
                slippageBps: 5000, 
                txVersion: 'V0',
                payer: wallet.publicKey.toBase58()
            }, { timeout: 5000 });

            if (res.data && res.data.success) {
                const txData = res.data.data[0].transaction;
                const tx = VersionedTransaction.deserialize(Buffer.from(txData, 'base64'));
                tx.sign([wallet]);
                
                const sig = await connection.sendRawTransaction(tx.serialize(), { 
                    skipPreflight: true,
                    maxRetries: 2 
                });
                
                bot.sendMessage(MY_ID, `🔥 V20 SNIPE SUCCESS!\nhttps://solscan.io/tx/${sig}`);
                return; // Stop if successful
            }
        } catch (e) {
            console.log(`🔄 Path ${endpoint.includes('v3') ? 'V3' : 'V2'} failed: ${e.code || 'Timeout'}`);
        }
    }
    console.log("🚨 All swap paths failed (ENOTFOUND or Timeout).");
}

async function buyToken(mint) {
    try {
        // Still vetting—Score 501 and 1404 skips prove this works!
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 3000 }).catch(() => ({ data: { score: 0 } }));
        if (rug.data.score > 500) return console.log(`⚠️ Skip: Score ${rug.data.score}`);
        
        await directStrike(mint);
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

console.log("🚀 V20 GHOST-PROTOCOL ONLINE.");
toggleScanning(true);
