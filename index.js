const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

// 🔥 CORRECTED BASE58 ADDRESSES (No underscores or dashes)
const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('D4pS7V9GgSt9H1tU5B6LpX7N3zXf9h4y5U7w3f7v9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";
let isPaused = false; 

// 1. COMMANDS & HEARTBEAT
bot.on('message', (msg) => {
    if (msg.text === '/balance') connection.getBalance(wallet.publicKey).then(b => bot.sendMessage(msg.chat.id, `💰 Balance: ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL`));
    if (msg.text === '/status') bot.sendMessage(msg.chat.id, `📊 Status: ${isPaused ? "COOLDOWN" : "HUNTING"}\n🎯 Targets: Legacy + CPMM Pools`);
});

// 2. AUTO-SELL WATCHDOG (+50% / -30%)
async function monitorPrice(mint, entryPrice, tokens) {
    const watchdog = setInterval(async () => {
        try {
            const quote = await jupiter.quoteGet({ inputMint: mint, outputMint: SOL_MINT, amount: tokens.toString(), slippageBps: 100 });
            const price = parseFloat(quote.outAmount) / tokens;
            if (price >= entryPrice * 1.5 || price <= entryPrice * 0.7) {
                clearInterval(watchdog);
                const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" } });
                const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
                tx.sign([wallet]);
                const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                bot.sendMessage(MY_ID, `🎯 ${price >= entryPrice * 1.5 ? "TAKE PROFIT" : "STOP LOSS"} HIT!\nhttps://solscan.io/tx/${sig}`);
            }
        } catch (e) { }
    }, 20000);
}

// 3. PERSISTENT BUYER (45s Loop)
async function buyToken(mint) {
    const start = Date.now();
    let quote = null;
    while (Date.now() - start < 45000) {
        try {
            quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: (0.01 * LAMPORTS_PER_SOL).toString(), slippageBps: 5000, onlyDirectRoutes: true });
            if (quote) break;
        } catch (e) { }
        await new Promise(r => setTimeout(r, 2500));
    }
    if (!quote) return bot.sendMessage(MY_ID, "❌ Jupiter Timeout: No route found.");
    try {
        const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto", dynamicComputeUnitLimit: true } });
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
        bot.sendMessage(MY_ID, `✅ BUY SUCCESS! 0.01 SOL\nhttps://solscan.io/tx/${sig}`);
        monitorPrice(mint, (0.01 * LAMPORTS_PER_SOL) / parseFloat(quote.outAmount), quote.outAmount);
    } catch (e) { console.log("🚨 Execution Error"); }
}

// 4. THE DUAL-EYE SLEDGEHAMMER SCANNER
[RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(programId => {
    connection.onLogs(programId, async ({ logs, signature, err }) => {
        console.log(`👀 Activity: ${signature.slice(0, 8)}...`);
        if (err || isPaused) return;

        const isNew = logs.some(l => {
            const low = l.toLowerCase();
            return low.includes("init") || low.includes("initialize2") || low.includes("createpool");
        });
        if (!isNew) return;

        console.log(`💎 SIGNAL: ${signature}`);
        let tx = null;
        for (let i = 0; i < 6; i++) {
            tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx) break;
            await new Promise(r => setTimeout(r, 1500));
        }
        if (!tx) return;

        try {
            const ix = tx.transaction.message.instructions.find(i => i.programId.equals(programId));
            let mint = null;
            for (let idx of [8, 9, 7, 10, 6]) {
                const addr = ix?.accounts[idx]?.toBase58();
                if (addr && addr.length > 30 && addr !== SOL_MINT && addr !== programId.toBase58()) { mint = addr; break; }
            }

            if (mint) {
                console.log(`🎯 TARGET ACQUIRED: ${mint}`);
                const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
                if (rug.data.score < 5000) {
                    isPaused = true;
                    bot.sendMessage(MY_ID, `🚀 SNIPING: ${mint}\nScore: ${rug.data.score}`);
                    await buyToken(mint);
                    setTimeout(() => { isPaused = false; }, 60000);
                }
            }
        } catch (e) { }
    }, 'processed');
});

bot.on('polling_error', (e) => { if (e.code !== 'EFATAL') console.log(`📡 Telegram Polling: ${e.code}`); });
console.log("🚀 APEX SCANNER LIVE. Monitoring Legacy + CPMM.");
