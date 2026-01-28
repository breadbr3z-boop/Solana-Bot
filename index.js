const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. SETUP
const connection = new Connection(process.env.RPC_URL, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL_MINT = "So11111111111111111111111111111111111111112";

console.log("🚀 Auto-Trader Started with TP/SL Guard...");

// 2. SELL FUNCTION (Back to SOL)
async function sellToken(mint, amountTokens) {
    try {
        console.log(`📡 Selling ${mint}...`);
        const quote = await jupiter.quoteGet({
            inputMint: mint,
            outputMint: SOL_MINT,
            amount: amountTokens.toString(),
            slippageBps: 2000, 
        });

        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true }
        });

        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        transaction.sign([wallet]);
        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });

        bot.sendMessage(MY_ID, `💰 SOLD! Exit realized.\nTx: https://solscan.io/tx/${signature}`);
    } catch (e) {
        console.error("🚨 Sell Failed:", e.message);
    }
}

// 3. MONITORING LOOP (The Watchdog)
async function startMonitoring(mint, entryPrice, tokenBalance) {
    const TP_PERCENT = 1.5; // +50%
    const SL_PERCENT = 0.7; // -30%
    
    bot.sendMessage(MY_ID, `👀 Monitoring ${mint.slice(0, 6)}...\nTP: +50% | SL: -30%`);

    const interval = setInterval(async () => {
        try {
            const quote = await jupiter.quoteGet({
                inputMint: mint,
                outputMint: SOL_MINT,
                amount: tokenBalance.toString(),
                slippageBps: 50, 
            });

            const currentPrice = parseFloat(quote.outAmount) / tokenBalance;
            const change = currentPrice / entryPrice;

            if (change >= TP_PERCENT) {
                bot.sendMessage(MY_ID, `🎯 TAKE PROFIT HIT! (+50%) Selling...`);
                clearInterval(interval);
                await sellToken(mint, tokenBalance);
            } else if (change <= SL_PERCENT) {
                bot.sendMessage(MY_ID, `📉 STOP LOSS HIT! (-30%) Selling...`);
                clearInterval(interval);
                await sellToken(mint, tokenBalance);
            }
        } catch (e) { console.log("Price check failed, retrying..."); }
    }, 20000); // Check every 20 seconds
}

// 4. BUY FUNCTION (Triggers Watchdog)
async function buyToken(mint, amountSol = 0.05) {
    try {
        const amountInLamports = Math.floor(amountSol * 1e9).toString();
        const quote = await jupiter.quoteGet({
            inputMint: SOL_MINT,
            outputMint: mint,
            amount: amountInLamports,
            slippageBps: 2000,
        });

        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true }
        });

        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        transaction.sign([wallet]);
        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });

        const tokenBalance = quote.outAmount;
        const entryPrice = parseFloat(amountInLamports) / parseFloat(tokenBalance);

        bot.sendMessage(MY_ID, `✅ BOUGHT: ${mint}\nEntry Price: ${entryPrice.toFixed(10)} SOL`);
        
        // 🔥 Start watching the price immediately
        startMonitoring(mint, entryPrice, tokenBalance);

    } catch (e) {
        console.error("🚨 Buy Error:", e.message);
    }
}

// 5. SCANNER & HEARTBEAT (Same as before)
connection.onLogs(RAYDIUM_ID, async ({ logs, signature, err }) => {
    if (err || !logs.some(log => log.includes("initialize2"))) return;
    try {
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        const tokenMint = tx?.transaction.message.instructions.find(ix => ix.programId.equals(RAYDIUM_ID))?.accounts[8].toBase58();
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, { headers: { 'User-Agent': 'Mozilla/5.0' } });

        if (rug.data.score < 500) {
            await buyToken(tokenMint);
        }
    } catch (e) { console.log("Scanning..."); }
}, 'confirmed');

setInterval(() => console.log("💓 Heartbeat: Still scanning..."), 60000);
bot.sendMessage(MY_ID, "🚀 Bot Active with Auto-Sell!");
