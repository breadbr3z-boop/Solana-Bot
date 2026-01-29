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
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL_MINT = "So11111111111111111111111111111111111111112";
let scanHistory = [];
let isPaused = false; 

// 🔥 HEARTBEAT
setInterval(() => { console.log(`💓 Bot Alive: ${new Date().toLocaleTimeString()}`); }, 60000);

// 📢 COMMANDS
bot.on('message', async (msg) => {
    const text = msg.text?.toLowerCase();
    if (text === '/balance') {
        const bal = await connection.getBalance(wallet.publicKey);
        bot.sendMessage(msg.chat.id, `💰 Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }
    if (text === '/status') bot.sendMessage(msg.chat.id, "📊 Status: ACTIVE - HUNTING POOLS");
});

// 2. THE PERSISTENT BUYER
async function buyToken(mint) {
    const startTime = Date.now();
    let quote = null;

    // 🔄 Loop for 40 seconds trying to get a price
    while (Date.now() - startTime < 40000) {
        try {
            console.log(`📡 Jupiter Indexing Check... (${((Date.now() - startTime) / 1000).toFixed(0)}s)`);
            quote = await jupiter.quoteGet({ 
                inputMint: SOL_MINT, 
                outputMint: mint, 
                amount: (0.01 * LAMPORTS_PER_SOL).toString(), 
                slippageBps: 5000, // 50% Slippage for testing
                onlyDirectRoutes: true 
            });
            if (quote) break;
        } catch (e) { /* Wait for index */ }
        await new Promise(r => setTimeout(r, 3000));
    }

    if (!quote) return bot.sendMessage(MY_ID, "❌ Jupiter Timeout: Route not found.");

    try {
        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" }
        });
        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        transaction.sign([wallet]);
        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
        bot.sendMessage(MY_ID, `✅ BUY SUCCESS! https://solscan.io/tx/${signature}`);
    } catch (e) { bot.sendMessage(MY_ID, `❌ Trade Error: ${e.message.slice(0, 30)}`); }
}

// 3. THE SLEDGEHAMMER SCANNER
connection.onLogs(RAYDIUM_ID, async ({ logs, signature, err }) => {
    console.log(`👀 Activity: ${signature.slice(0, 8)}...`);
    if (err || isPaused || !logs.some(log => log.toLowerCase().includes("initialize2"))) return;

    console.log(`💎 NEW POOL: ${signature}`);
    
    // Try to parse the Mint 5 times
    let tx = null;
    for (let i = 0; i < 5; i++) {
        tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (tx) break;
        await new Promise(r => setTimeout(r, 1500));
    }

    if (!tx) return;

    try {
        const raydiumIx = tx.transaction.message.instructions.find(ix => ix.programId.equals(RAYDIUM_ID));
        let tokenMint = null;
        if (raydiumIx?.accounts) {
            for (let idx of [8, 9, 7]) { // Check common slots
                const addr = raydiumIx.accounts[idx]?.toBase58();
                if (addr && addr !== SOL_MINT && addr.length > 30) { tokenMint = addr; break; }
            }
        }

        if (tokenMint) {
            console.log(`🎯 TARGET: ${tokenMint}`);
            const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`);
            if (rug.data.score < 5000) {
                isPaused = true;
                bot.sendMessage(MY_ID, `🚀 SNIPING: ${tokenMint}`);
                await buyToken(tokenMint);
                setTimeout(() => { isPaused = false; }, 60000); 
            }
        }
    } catch (e) { console.log("🚨 Parse Error"); }
}, 'processed');

console.log("🚀 TOTAL RESET COMPLETE. BOT IS LIVE.");
