const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. SETUP
const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

// 🔥 VERIFIED PROGRAM IDs
const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";
let isPaused = false; 

// 2. COMMANDS
bot.on('message', (msg) => {
    if (msg.text === '/balance') connection.getBalance(wallet.publicKey).then(b => bot.sendMessage(msg.chat.id, `💰 Balance: ${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL`));
    if (msg.text === '/status') bot.sendMessage(msg.chat.id, "📊 Status: ACTIVE - DEEP SCANNING");
});
setInterval(() => console.log(`💓 Heartbeat: ${new Date().toLocaleTimeString()}`), 60000);

// 3. AUTO-SELL MONITOR (+50% / -30%)
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
                await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                bot.sendMessage(MY_ID, `🎯 ${price >= entryPrice * 1.5 ? "TP" : "SL"} HIT! Sold.`);
            }
        } catch (e) { }
    }, 20000);
}

// 4. PERSISTENT BUYER (45s Loop)
async function buyToken(mint) {
    const start = Date.now();
    let quote = null;
    while (Date.now() - start < 45000) {
        try {
            console.log(`📡 Jupiter Syncing... ${mint.slice(0, 5)}`);
            quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: (0.01 * LAMPORTS_PER_SOL).toString(), slippageBps: 5000, onlyDirectRoutes: true });
            if (quote) break;
        } catch (e) { }
        await new Promise(r => setTimeout(r, 2500));
    }
    if (!quote) return bot.sendMessage(MY_ID, "❌ Jupiter Timeout.");
    try {
        const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto", dynamicComputeUnitLimit: true } });
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
        bot.sendMessage(MY_ID, `✅ BUY SUCCESS!\nhttps://solscan.io/tx/${sig}`);
        monitorPrice(mint, (0.01 * LAMPORTS_PER_SOL) / parseFloat(quote.outAmount), quote.outAmount);
    } catch (e) { console.log("🚨 Execution Fail"); }
}

// 5. DEEP-SEARCH SCANNER
[RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
    connection.onLogs(pId, async ({ logs, signature, err }) => {
        console.log(`👀 Activity: ${signature.slice(0, 8)}...`);
        if (err || isPaused || !logs.some(l => l.toLowerCase().includes("init"))) return;

        console.log(`💎 SIGNAL: ${signature}`);
        let tx = null;
        for (let i = 0; i < 8; i++) {
            tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx) break;
            await new Promise(r => setTimeout(r, 2000));
        }
        if (!tx) return console.log("❌ Parse Timeout");

        try {
            // Find Mint by scanning all account keys in the transaction
            const allAccounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
            let mint = null;
            for (const addr of allAccounts) {
                if (addr !== SOL_MINT && addr !== pId.toBase58() && addr !== wallet.publicKey.toBase58() && !addr.startsWith('1111') && !addr.startsWith('Tokenkeg')) {
                    mint = addr;
                    break; 
                }
            }

            if (mint) {
                console.log(`🎯 TARGET: ${mint}`);
                const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
                console.log(`🛡️ RUG SCORE: ${rug.data.score}`);

                if (rug.data.score < 5000) {
                    isPaused = true;
                    bot.sendMessage(MY_ID, `🚀 BUYING: ${mint}\nScore: ${rug.data.score}`);
                    await buyToken(mint);
                    setTimeout(() => { isPaused = false; }, 60000);
                }
            }
        } catch (e) { console.log("🚨 Scan Error"); }
    }, 'processed');
});

console.log("🚀 DEEP-SCAN APEX READY.");
