const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));

// 🛡️ STABILITY: Polling interval to prevent 429 Rate Limits
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { 
    polling: { interval: 2000, autoStart: true } 
});
const MY_ID = process.env.CHAT_ID;

const JUP_ENDPOINTS = ["https://quote-api.jup.ag/v6", "https://api.jup.ag/v6"];
const SOL_MINT = "So11111111111111111111111111111111111111112";

let activeTrades = new Set();

// 🎯 WATCHDOG: Take Profit (+50%) & Stop Loss (-30%)
async function startWatchdog(mint, entryPrice, tokens) {
    if (activeTrades.has(mint)) return;
    activeTrades.add(mint);
    bot.sendMessage(MY_ID, `🛰️ Watchdog Active: ${mint.slice(0,6)}\nEntry: ${entryPrice.toFixed(8)}`).catch(() => {});

    const interval = setInterval(async () => {
        try {
            const res = await axios.get(`${JUP_ENDPOINTS[0]}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${tokens}&slippageBps=100`);
            const currentPrice = parseFloat(res.data.outAmount) / tokens;
            
            const isTP = currentPrice >= entryPrice * 1.5; 
            const isSL = currentPrice <= entryPrice * 0.7; 

            if (isTP || isSL) {
                clearInterval(interval);
                const swapRes = await axios.post(`${JUP_ENDPOINTS[0]}/swap`, {
                    quoteResponse: res.data,
                    userPublicKey: wallet.publicKey.toBase58(),
                    prioritizationFeeLamports: 1000000
                });
                const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.data.swapTransaction, 'base64'));
                tx.sign([wallet]);
                await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                
                bot.sendMessage(MY_ID, `🎯 ${isTP ? '🚀 PROFIT (+50%)' : '📉 STOP LOSS (-30%)'}\nSold ${mint.slice(0,6)}`).catch(() => {});
                activeTrades.delete(mint);
            }
        } catch (e) { }
    }, 20000); 
}

// 🚀 STRIKE: With DNS Bypass & Telegram
async function strike(mint) {
    bot.sendMessage(MY_ID, `🔍 Target Spotted: ${mint.slice(0,8)}`).catch(() => {});
    let quote = null;
    let endpoint = "";

    for (const url of JUP_ENDPOINTS) {
        try {
            const res = await axios.get(`${url}/quote`, {
                params: { inputMint: SOL_MINT, outputMint: mint, amount: 0.01 * LAMPORTS_PER_SOL, slippageBps: 5000, onlyDirectRoutes: true },
                timeout: 4000
            });
            if (res.data) { quote = res.data; endpoint = url; break; }
        } catch (e) { }
    }

    if (!quote) return;

    try {
        const { data: swap } = await axios.post(`${endpoint}/swap`, {
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            prioritizationFeeLamports: 3000000, // 3M Bribe
            wrapAndUnwrapSol: true
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });

        bot.sendMessage(MY_ID, `💎 SNIPE SUCCESS!\nhttps://solscan.io/tx/${sig}`).catch(() => {});
        
        const entryPrice = (0.01 * LAMPORTS_PER_SOL) / parseFloat(quote.outAmount);
        startWatchdog(mint, entryPrice, quote.outAmount);
    } catch (e) {
        bot.sendMessage(MY_ID, `🚨 Strike Error: ${e.message}`).catch(() => {});
    }
}

// ⛓️ SCANNER: Includes RugCheck
async function main() {
    console.log("V37 Final Sentinel Online.");
    const RAY_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    
    connection.onLogs(RAY_V4, async ({ signature, logs, err }) => {
        if (err || !logs.some(l => l.toLowerCase().includes("init"))) return;
        try {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            const mint = tx?.meta?.postTokenBalances?.find(b => b.mint !== SOL_MINT && b.owner !== RAY_V4.toBase58())?.mint;
            
            if (mint) {
                // 🛡️ RUGCHECK: Skip if score > 500
                const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`).catch(() => ({ data: { score: 0 } }));
                if (rug.data.score <= 500) {
                    await strike(mint);
                } else {
                    console.log(`☣️ Rug Blocked: ${rug.data.score}`);
                }
            }
        } catch (e) { }
    }, 'processed');
}

bot.onText(/\/balance/, async () => {
    const bal = await connection.getBalance(wallet.publicKey);
    bot.sendMessage(MY_ID, `💰 Wallet: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`).catch(() => {});
});

main();
