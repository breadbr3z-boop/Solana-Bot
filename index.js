const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs'); // 📂 Needed for /log
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_API = "https://quote-api.jup.ag/v6";

let isScanning = true;
let isWorking = false;
let activeTrades = new Set();
let logHistory = []; // 📝 Stores recent activity for /log

// 📝 LOGGING HELPER
function addToLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${msg}`;
    console.log(entry);
    logHistory.push(entry);
    if (logHistory.length > 20) logHistory.shift(); // Keep last 20 lines
}

// 🎯 WATCHDOG: TP +50% / SL -30%
async function startWatchdog(mint, entryPrice, tokens) {
    if (activeTrades.has(mint)) return;
    activeTrades.add(mint);
    const interval = setInterval(async () => {
        try {
            const res = await axios.get(`${JUP_API}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${tokens}&slippageBps=100`);
            const currentPrice = parseFloat(res.data.outAmount) / tokens;
            
            if (currentPrice >= entryPrice * 1.5 || currentPrice <= entryPrice * 0.7) {
                clearInterval(interval);
                const swap = await axios.post(`${JUP_API}/swap`, { quoteResponse: res.data, userPublicKey: wallet.publicKey.toBase58(), prioritizationFeeLamports: 500000 });
                const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
                tx.sign([wallet]);
                await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                
                const result = currentPrice >= entryPrice * 1.5 ? '🚀 PROFIT' : '📉 LOSS';
                addToLog(`SOLD ${mint.slice(0,6)} for ${result}`);
                bot.sendMessage(MY_ID, `🎯 AUTO-SELL: ${result}\nMint: ${mint.slice(0,6)}`);
                activeTrades.delete(mint);
            }
        } catch (e) { }
    }, 20000);
}

// 🚀 THE INFINITE HUNT (V25)
async function executeSnipe(mint) {
    addToLog(`HUNTING: ${mint.slice(0,6)}`);
    bot.sendMessage(MY_ID, `🔍 Target: ${mint.slice(0,8)}\nStatus: Infinite Hunt (5m window)`);

    for (let i = 0; i < 150; i++) {
        if (!isScanning) return;
        try {
            const slippage = i < 30 ? 2500 : 5000; 
            const quoteRes = await axios.get(`${JUP_API}/quote`, {
                params: { inputMint: SOL_MINT, outputMint: mint, amount: 0.01 * LAMPORTS_PER_SOL, slippageBps: slippage, onlyDirectRoutes: true },
                timeout: 1500
            });

            const swapRes = await axios.post(`${JUP_API}/swap`, {
                quoteResponse: quoteRes.data, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: 1200000, dynamicComputeUnitLimit: true
            });

            const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.data.swapTransaction, 'base64'));
            tx.sign([wallet]);
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
            
            addToLog(`BUY SUCCESS: ${mint.slice(0,6)}`);
            bot.sendMessage(MY_ID, `💎 SNIPE SUCCESS!\nTX: https://solscan.io/tx/${sig}`);
            startWatchdog(mint, (0.01 * LAMPORTS_PER_SOL) / parseFloat(quoteRes.data.outAmount), quoteRes.data.outAmount);
            return;
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    addToLog(`HUNT FAILED: ${mint.slice(0,6)}`);
    bot.sendMessage(MY_ID, `🚨 Hunt Failed: Time limit exceeded.`);
}

// 🛡️ COMMANDS
bot.onText(/\/log/, () => {
    const report = logHistory.length > 0 ? logHistory.join('\n') : "Logs are empty.";
    bot.sendMessage(MY_ID, `📋 **Recent Activity:**\n\`\`\`\n${report}\n\`\`\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/balance/, async () => {
    const bal = await connection.getBalance(wallet.publicKey);
    bot.sendMessage(MY_ID, `💰 Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
});

bot.onText(/\/status/, () => {
    bot.sendMessage(MY_ID, `🤖 Bot: ${isScanning ? '✅ ON' : '🛑 OFF'}\n📦 Trades: ${activeTrades.size}`);
});

bot.onText(/\/stop/, () => { isScanning = false; bot.sendMessage(MY_ID, "🛑 Scanning Paused."); });
bot.onText(/\/start/, () => { isScanning = true; bot.sendMessage(MY_ID, "🚀 Scanning Started."); });

// ⛓️ SCANNER
async function main() {
    const RAY_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    connection.onLogs(RAY_V4, async ({ signature, logs, err }) => {
        if (!isScanning || isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;
        isWorking = true;
        try {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx) {
                const mint = tx.meta.postTokenBalances.find(b => b.mint !== SOL_MINT && b.owner !== RAY_V4.toBase58())?.mint;
                if (mint) {
                    const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`).catch(() => ({ data: { score: 0 } }));
                    if (rug.data.score <= 500) {
                        await executeSnipe(mint);
                    } else {
                        addToLog(`SKIPPED: Rug Score ${rug.data.score}`);
                    }
                }
            }
        } catch (e) { }
        setTimeout(() => { isWorking = false; }, 5000); 
    }, 'processed');
}

process.once('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
addToLog("Bot Started - V25 Master Sentinel");
main();
