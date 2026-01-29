const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. DUAL-PIPE CONNECTION (Standard + WebSocket)
const connection = new Connection(process.env.RPC_URL, {
    wsEndpoint: process.env.WSS_URL, 
    commitment: 'processed'
});

const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL_MINT = "So11111111111111111111111111111111111111112";
let scanHistory = [];

// 🔥 INDEPENDENT HEARTBEAT
const heartbeat = setInterval(() => {
    console.log(`💓 Heartbeat: ${new Date().toLocaleTimeString()} | Bot Engine Healthy`);
}, 60000);
heartbeat.unref(); 

// 📢 COMMAND LISTENER
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.toLowerCase();

    if (text === '/start' || text === 'ping') {
        bot.sendMessage(chatId, "👋 Connection verified! I am scanning Solana Raydium launches...");
    } 
    else if (text === '/status') {
        try {
            const version = await connection.getVersion();
            bot.sendMessage(chatId, `📊 Status: ONLINE\n🧬 Node: ${version["solana-core"]}\n🛡️ Filter: RugCheck < 500\n🚀 Priority: AUTO`);
        } catch (e) { bot.sendMessage(chatId, "⚠️ Status: DEGRADED"); }
    } 
    else if (text === '/balance') {
        try {
            const bal = await connection.getBalance(wallet.publicKey);
            bot.sendMessage(chatId, `💰 Wallet: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        } catch (e) { bot.sendMessage(chatId, "❌ Balance check failed."); }
    } 
    else if (text === '/log') {
        if (scanHistory.length === 0) bot.sendMessage(chatId, "📁 Log empty. No new pools detected since restart.");
        else {
            const report = scanHistory.map(h => `📍 ${h.time} | Score: ${h.score} | ${h.action}\nMint: ${h.mint.slice(0, 10)}...`).join('\n\n');
            bot.sendMessage(chatId, `📋 Recent Activity:\n\n${report}`);
        }
    }
    // 🧪 NEW: TEST LOG COMMAND
    else if (text === '/testlog') {
        const fakeMint = "TEST_MINT_" + Math.floor(Math.random() * 1000);
        const fakeScore = Math.floor(Math.random() * 1000);
        const action = fakeScore < 500 ? "✅ BOUGHT (Simulated)" : "❌ SKIPPED (Simulated)";
        
        scanHistory.unshift({ time: new Date().toLocaleTimeString(), mint: fakeMint, score: fakeScore, action: action });
        if (scanHistory.length > 5) scanHistory.pop();
        
        bot.sendMessage(chatId, `🧪 TEST ALERT:\nDetected: ${fakeMint}\nSafety Score: ${fakeScore}\nAction: ${action}\n\n*Check /log to see this entry!*`);
        console.log("🛠️ Manual Test Log Triggered");
    }
});

// 2. SELL FUNCTION
async function sellToken(mint, amountTokens) {
    try {
        const quote = await jupiter.quoteGet({ inputMint: mint, outputMint: SOL_MINT, amount: amountTokens.toString(), slippageBps: 2000 });
        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" }
        });
        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        transaction.sign([wallet]);
        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `💰 SOLD! https://solscan.io/tx/${signature}`);
    } catch (e) { console.error("🚨 Sell Failed:", e.message); }
}

// 3. MONITORING LOOP
async function startMonitoring(mint, entryPrice, tokenBalance) {
    const interval = setInterval(async () => {
        try {
            const quote = await jupiter.quoteGet({ inputMint: mint, outputMint: SOL_MINT, amount: tokenBalance.toString(), slippageBps: 100 });
            const currentPrice = parseFloat(quote.outAmount) / tokenBalance;
            const change = currentPrice / entryPrice;
            if (change >= 1.5) { bot.sendMessage(MY_ID, `🎯 TP HIT (+50%)`); clearInterval(interval); await sellToken(mint, tokenBalance); }
            else if (change <= 0.7) { bot.sendMessage(MY_ID, `📉 SL HIT (-30%)`); clearInterval(interval); await sellToken(mint, tokenBalance); }
        } catch (e) { }
    }, 15000);
}

// 4. BUY FUNCTION
async function buyToken(mint, amountSol = 0.05) {
    try {
        console.log(`⏳ Waiting 5s for liquidity...`);
        await new Promise(r => setTimeout(r, 5000)); 
        const amountInLamports = Math.floor(amountSol * 1e9).toString();
        const quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: amountInLamports, slippageBps: 2500 }); 
        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" }
        });
        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        transaction.sign([wallet]);
        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `✅ BOUGHT: ${mint}\nTX: https://solscan.io/tx/${signature}`);
        startMonitoring(mint, (parseFloat(amountInLamports) / parseFloat(quote.outAmount)), quote.outAmount);
    } catch (e) { 
        console.error("🚨 Buy Error:", e.message);
        bot.sendMessage(MY_ID, `❌ Buy Failed: ${e.message.slice(0, 50)}...`);
    }
}

// 5. SCANNER (The Listening Engine)
connection.onLogs(RAYDIUM_ID, async ({ logs, signature, err }) => {
    console.log(`👀 Activity: ${signature.slice(0, 8)}...`);
    if (err || !logs.some(log => log.includes("initialize2"))) return;

    try {
        console.log(`💎 NEW POOL DETECTED: ${signature}`);
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        const tokenMint = tx?.transaction.message.instructions.find(ix => ix.programId.equals(RAYDIUM_ID))?.accounts[8].toBase58();

        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, { timeout: 5000 });
        const score = rug.data.score;
        const action = score < 500 ? "✅ BOUGHT" : "❌ SKIPPED";

        scanHistory.unshift({ time: new Date().toLocaleTimeString(), mint: tokenMint, score: score, action: action });
        if (scanHistory.length > 5) scanHistory.pop();

        if (score < 500) {
            bot.sendMessage(MY_ID, `🚀 SNIPING SAFE TOKEN: ${tokenMint}\nScore: ${score}`);
            await buyToken(tokenMint);
        }
    } catch (e) { }
}, 'processed');

console.log("🚀 MASTER BOT WITH TEST LOGS LIVE.");
