const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. DUAL-PIPE CONNECTION
const connection = new Connection(process.env.RPC_URL, {
    wsEndpoint: process.env.WSS_URL, 
    commitment: 'processed'
});

const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

// 🛡️ STURDY TELEGRAM POLLING
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
    polling: { params: { timeout: 10 }, interval: 300, autoStart: true }
});

const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL_MINT = "So11111111111111111111111111111111111111112";
let scanHistory = [];
let isPaused = false; 

// 🔥 HEARTBEAT
const heartbeat = setInterval(() => {
    console.log(`💓 Heartbeat: ${new Date().toLocaleTimeString()} | Sledgehammer Mode Active`);
}, 60000);
heartbeat.unref(); 

// 📢 TELEGRAM COMMANDS
bot.on('message', async (msg) => {
    const text = msg.text?.toLowerCase();
    if (text === '/status') bot.sendMessage(msg.chat.id, `📊 Status: SLEDGEHAMMER ACTIVE\n💰 Buy: 0.01 SOL\n🛡️ Filter: < 5000\n⏳ Cooldown: ${isPaused ? "ACTIVE" : "READY"}`);
    if (text === '/balance') {
        const bal = await connection.getBalance(wallet.publicKey).catch(() => 0);
        bot.sendMessage(msg.chat.id, `💰 Wallet: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }
    if (text === '/log') {
        if (scanHistory.length === 0) bot.sendMessage(msg.chat.id, "📁 Log empty. Awaiting first target...");
        else {
            const report = scanHistory.slice(0, 10).map(h => `📍 ${h.time} | Score: ${h.score} | ${h.action}`).join('\n\n');
            bot.sendMessage(msg.chat.id, `📋 Recent Activity:\n\n${report}`);
        }
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

// 3. MONITORING (+50% / -30%)
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

// 4. PERSISTENT BUY FUNCTION
async function buyToken(mint, amountSol = 0.01) {
    const amountInLamports = Math.floor(amountSol * 1e9).toString();
    const startTime = Date.now();
    let quote = null;

    while (Date.now() - startTime < 30000) { // Try for 30s
        try {
            console.log(`📡 Fetching route for ${mint.slice(0, 6)}... (${((Date.now() - startTime) / 1000).toFixed(0)}s)`);
            quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: amountInLamports, slippageBps: 5000, onlyDirectRoutes: true });
            if (quote) break;
        } catch (e) { }
        await new Promise(r => setTimeout(r, 2000));
    }

    if (!quote) {
        bot.sendMessage(MY_ID, `❌ Timeout: Jupiter couldn't index ${mint.slice(0, 6)}`);
        return;
    }

    try {
        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto", dynamicComputeUnitLimit: true }
        });

        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        transaction.sign([wallet]);
        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
        bot.sendMessage(MY_ID, `✅ BUY SENT! https://solscan.io/tx/${signature}`);
        startMonitoring(mint, (parseFloat(amountInLamports) / parseFloat(quote.outAmount)), quote.outAmount);
    } catch (e) { bot.sendMessage(MY_ID, `❌ Execution Failed: ${e.message.slice(0, 30)}`); }
}

// 5. THE SLEDGEHAMMER SCANNER
connection.onLogs(RAYDIUM_ID, async ({ logs, signature, err }) => {
    console.log(`👀 Activity: ${signature.slice(0, 8)}...`);
    if (err || isPaused) return;

    if (logs.some(log => log.toLowerCase().includes("initialize2"))) {
        console.log(`💎 NEW POOL DETECTED: ${signature}`);
        
        let tx = null;
        for (let i = 0; i < 5; i++) { // Retry 5 times to parse
            console.log(`🔍 Parsing attempt ${i + 1}...`);
            tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx) break;
            await new Promise(r => setTimeout(r, 1500));
        }

        if (!tx) { console.log("❌ FAILED: Transaction never indexed."); return; }

        try {
            const raydiumIx = tx.transaction.message.instructions.find(ix => ix.programId.equals(RAYDIUM_ID));
            let tokenMint = null;

            if (raydiumIx?.accounts) {
                for (let idx of [8, 9, 7, 10, 6]) { // Wide index search
                    const addr = raydiumIx.accounts[idx]?.toBase58();
                    if (addr && addr !== SOL_MINT && addr.length > 30 && addr !== RAYDIUM_ID.toBase58()) {
                        tokenMint = addr;
                        break;
                    }
                }
            }

            if (!tokenMint) { console.log("⚠️ Mint not found."); return; }

            console.log(`🎯 TARGET ACQUIRED: ${tokenMint}`);
            const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, { timeout: 5000 });
            const score = rug.data.score;

            scanHistory.unshift({ time: new Date().toLocaleTimeString(), mint: tokenMint, score: score, action: score < 5000 ? "✅ BOUGHT" : "❌ SKIPPED" });

            if (score < 5000) {
                isPaused = true;
                bot.sendMessage(MY_ID, `🚀 TARGET: ${tokenMint}\nScore: ${score}\nBuying 0.01 SOL...`);
                await buyToken(tokenMint);
                setTimeout(() => { isPaused = false; console.log("🔓 Cooldown over."); }, 60000); 
            }
        } catch (e) { console.log("🚨 Parse Logic Error"); }
    }
}, 'processed');

// Suppress polling noise
bot.on('polling_error', (error) => { if (error.code !== 'EFATAL') console.log(`📡 Telegram: ${error.code}`); });

console.log("🚀 SLEDGEHAMMER MASTER BOT LIVE.");
