const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. SYSTEM SETUP
const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_IP = "https://74.125.22.103"; // Direct IP to bypass Railway DNS blocks

let isWorking = false;
let subIds = [];

// 🎯 AUTO-SELL WATCHDOG (+50% TP / -30% SL)
async function monitorPrice(mint, entryPrice, tokens) {
    console.log(`📡 Watchdog Active: Monitoring ${mint.slice(0,6)}`);
    const interval = setInterval(async () => {
        try {
            // Check current price via Direct IP
            const res = await axios.get(`${JUP_IP}/v6/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${tokens}&slippageBps=100`, { 
                headers: { 'Host': 'quote-api.jup.ag', 'User-Agent': 'Mozilla/5.0' } 
            });
            const currentPrice = parseFloat(res.data.outAmount) / tokens;
            
            if (currentPrice >= entryPrice * 1.5 || currentPrice <= entryPrice * 0.7) {
                clearInterval(interval);
                const swap = await axios.post(`${JUP_IP}/v6/swap`, { 
                    quoteResponse: res.data, 
                    userPublicKey: wallet.publicKey.toBase58(), 
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 300000 
                }, { headers: { 'Host': 'quote-api.jup.ag' } });
                
                const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
                tx.sign([wallet]);
                const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                bot.sendMessage(MY_ID, `🎯 AUTO-SELL: ${currentPrice >= entryPrice * 1.5 ? "TAKE PROFIT 🚀" : "STOP LOSS 📉"}\nhttps://solscan.io/tx/${sig}`);
            }
        } catch (e) { /* Silent retry */ }
    }, 30000); 
}

// 🚀 THE "PATIENT" BUYER (RugCheck 500 + IP Direct)
async function buyToken(mint) {
    try {
        console.log(`🛡️ Vetting ${mint} (Max Score: 500)`);
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 5000 });
        
        if (rug.data.score > 500) {
            console.log(`⚠️ Rejected: Score ${rug.data.score}`);
            return;
        }

        const amount = Math.floor(0.01 * LAMPORTS_PER_SOL);
        let quote = null;

        // 🛠️ THE 3-MINUTE PATIENCE LOOP (Handles Jupiter Indexing)
        for (let i = 0; i < 60; i++) { 
            try {
                const res = await axios.get(`${JUP_IP}/v6/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${amount}&slippageBps=2000`, { 
                    headers: { 'Host': 'quote-api.jup.ag', 'User-Agent': 'Mozilla/5.0' } 
                });
                quote = res.data;
                break; 
            } catch (e) { 
                if (i % 5 === 0) console.log(`🔄 Waiting for Jupiter Indexing... (${i}/60)`);
                await new Promise(r => setTimeout(r, 3000)); 
            }
        }

        if (!quote) throw new Error("Jupiter Timeout");

        const swap = await axios.post(`${JUP_IP}/v6/swap`, { 
            quoteResponse: quote, 
            userPublicKey: wallet.publicKey.toBase58(), 
            wrapAndUnwrapSol: true, 
            prioritizationFeeLamports: 500000,
            dynamicComputeUnitLimit: true 
        }, { headers: { 'Host': 'quote-api.jup.ag', 'User-Agent': 'Mozilla/5.0' } });

        const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        
        bot.sendMessage(MY_ID, `💎 ELITE SNIPE SUCCESS!\nScore: ${rug.data.score}\nhttps://solscan.io/tx/${sig}`);
        
        // Start TP/SL Watchdog
        monitorPrice(mint, amount / parseFloat(quote.outAmount), quote.outAmount);
        
    } catch (e) {
        console.log(`🚨 Buy Fail: ${e.response?.data?.message || e.message}`);
    }
}

// 🛡️ SCANNER WITH MEMORY LOCK
async function toggleScanning(on) {
    if (!on) {
        for (let id of subIds) await connection.removeOnLogsListener(id).catch(() => {});
        subIds = [];
    } else {
        const RAY_AMM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
        const RAY_CPMM = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A');
        
        [RAY_AMM, RAY_CPMM].forEach(pId => {
            const id = connection.onLogs(pId, async ({ signature, logs, err }) => {
                if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;
                isWorking = true;
                await toggleScanning(false); 
                
                try {
                    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (tx) {
                        const mint = tx.meta.postTokenBalances.find(b => b.mint !== SOL_MINT && b.owner !== pId.toBase58())?.mint;
                        if (mint) {
                            console.log(`🎯 TARGET: ${mint}`);
                            await buyToken(mint);
                        }
                    }
                } catch (e) { }
                setTimeout(() => { isWorking = false; toggleScanning(true); }, 45000);
            }, 'processed');
            subIds.push(id);
        });
    }
}

process.on('uncaughtException', (err) => { 
    isWorking = false; 
    toggleScanning(true); 
});

console.log("🚀 IRONCLAD V8 MASTER ONLINE. FINAL DEPLOY.");
toggleScanning(true);
