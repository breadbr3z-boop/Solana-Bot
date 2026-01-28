const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. SETUP
const connection = new Connection(process.env.RPC_URL, 'processed'); 
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL_MINT = "So11111111111111111111111111111111111111112";

// 🔥 INDEPENDENT HEARTBEAT (Bulletproof)
const heartbeat = setInterval(() => {
    console.log(`💓 Heartbeat: ${new Date().toLocaleTimeString()} | Scanning Solana...`);
}, 60000);
heartbeat.unref(); 

// 📢 TALK BACK FEATURE & BALANCE COMMAND
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.toLowerCase();

    if (text === '/start' || text === 'ping') {
        bot.sendMessage(chatId, "👋 I'm alive! Currently scanning for safe launches...");
    } else if (text === '/status') {
        bot.sendMessage(chatId, "📊 Status: ACTIVE\n🛡️ Safety: RugCheck < 500\n💰 Buy: 0.05 SOL\n🎯 TP: +50% | SL: -30%");
    } else if (text === '/balance') {
        try {
            const bal = await connection.getBalance(wallet.publicKey);
            bot.sendMessage(chatId, `💰 Wallet Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        } catch (e) {
            bot.sendMessage(chatId, "❌ Error fetching balance.");
        }
    }
});

// 2. SELL FUNCTION
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

        bot.sendMessage(MY_ID, `💰 SOLD! Exit realized.\nhttps://solscan.io/tx/${signature}`);
    } catch (e) {
        console.error("🚨 Sell Failed:", e.message);
    }
}

// 3. MONITORING LOOP (Watchdog)
async function startMonitoring(mint, entryPrice, tokenBalance) {
    const TP_PERCENT = 1.5; // +50%
    const SL_PERCENT = 0.7; // -30%
    
    const interval = setInterval(async () => {
        try {
            const quote = await jupiter.quoteGet({
                inputMint: mint,
                outputMint: SOL_MINT,
                amount: tokenBalance.toString(),
                slippageBps: 100, 
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
        } catch (e) { /* silent retry */ }
    }, 15000); 
}

// 4. BUY FUNCTION
async function buyToken(mint, amountSol = 0.05) {
    try {
        console.log(`⏳ Waiting 3s for liquidity to settle...`);
        await new Promise(r => setTimeout(r, 3000)); 

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

        bot.sendMessage(MY_ID, `✅ BOUGHT: ${mint}\nEntry: ${entryPrice.toFixed(10)} SOL`);
        startMonitoring(mint, entryPrice, tokenBalance);
    } catch (e) {
        console.error("🚨 Buy Error:", e.message);
    }
}

// 5. SCANNER
connection.onLogs(RAYDIUM_ID, async ({ logs, signature, err }) => {
    if (err || !logs.some(log => log.includes("initialize2"))) return;

    try {
        console.log(`⚡ New Launch! checking ${signature.slice(0, 8)}...`);
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        const tokenMint = tx?.transaction.message.instructions.find(ix => ix.programId.equals(RAYDIUM_ID))?.accounts[8].toBase58();

        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, { timeout: 5000 });
        const score = rug.data.score;

        if (score < 500) {
            bot.sendMessage(MY_ID, `💎 SAFE TOKEN: ${tokenMint}\nScore: ${score}`);
            await buyToken(tokenMint);
        } else {
            console.log(`❌ Skipped: Score ${score}`);
        }
    } catch (e) { /* ignore scan errors */ }
}, 'processed');

console.log("🚀 Bot is LIVE. Ready to trade.");
bot.sendMessage(MY_ID, "🚀 Bot Active! Commands:\n/balance - Check wallet\n/status - Bot settings\nping - Test connection");
