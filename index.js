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
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: { autoStart: true } });
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL_MINT = "So11111111111111111111111111111111111111112";
let scanHistory = [];
let isPaused = false; 

// 📢 COMMANDS
bot.on('message', async (msg) => {
    const text = msg.text?.toLowerCase();
    if (text === '/status') bot.sendMessage(msg.chat.id, `📊 Status: AGGRESSIVE TEST\n💰 Buy: 0.01 SOL\n🛡️ Filter: < 5000`);
    if (text === '/balance') {
        const bal = await connection.getBalance(wallet.publicKey).catch(() => 0);
        bot.sendMessage(msg.chat.id, `💰 Wallet: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }
});

// 2. THE AGGRESSIVE BUY FUNCTION
async function buyToken(mint, amountSol = 0.01) {
    try {
        let quote = null;
        const amountInLamports = Math.floor(amountSol * 1e9).toString();

        // 🔄 RETRY LOOP: Wait for Jupiter to index the coin
        for (let i = 0; i < 3; i++) {
            console.log(`⏳ Attempt ${i+1}: Fetching quote for ${mint}...`);
            try {
                quote = await jupiter.quoteGet({ 
                    inputMint: SOL_MINT, 
                    outputMint: mint, 
                    amount: amountInLamports, 
                    slippageBps: 3000, // 30% Slippage for launches
                    onlyDirectRoutes: true 
                });
                if (quote) break;
            } catch (e) { console.log("   ↳ Token not indexed yet, waiting..."); }
            await new Promise(r => setTimeout(r, 5000)); // Wait 5s between retries
        }

        if (!quote) throw new Error("Jupiter could not find a route after 15s.");

        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { 
                quoteResponse: quote, 
                userPublicKey: wallet.publicKey.toBase58(), 
                wrapAndUnwrapSol: true, 
                prioritizationFeeLamports: "auto",
                dynamicComputeUnitLimit: true
            }
        });

        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        transaction.sign([wallet]);
        
        // 🏎️ SKIP PREFLIGHT: Send directly to the chain
        const signature = await connection.sendRawTransaction(transaction.serialize(), { 
            skipPreflight: true, 
            maxRetries: 2 
        });
        
        bot.sendMessage(MY_ID, `✅ BUY SENT! 0.01 SOL\nTX: https://solscan.io/tx/${signature}`);
        console.log(`🔥 SUCCESS: https://solscan.io/tx/${signature}`);
    } catch (e) { 
        console.error("🚨 BUY FAILED:", e.message);
        bot.sendMessage(MY_ID, `❌ Buy Failed: ${e.message.slice(0, 40)}`);
    }
}

// 3. UNIVERSAL SCANNER
connection.onLogs(RAYDIUM_ID, async ({ logs, signature, err }) => {
    console.log(`👀 Activity: ${signature.slice(0, 8)}...`);
    if (err || isPaused) return;

    const isNewPool = logs.some(log => {
        const l = log.toLowerCase();
        return l.includes("initialize2") || l.includes("initialize") || (l.includes("pool") && l.includes("init"));
    });

    if (!isNewPool) return;

    try {
        console.log(`💎 NEW POOL DETECTED: ${signature}`);
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        const ix = tx?.transaction.message.instructions.find(i => i.programId.equals(RAYDIUM_ID));
        const tokenMint = ix?.accounts[8]?.toBase58() || ix?.accounts[9]?.toBase58();

        if (!tokenMint || tokenMint === SOL_MINT) return;

        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, { timeout: 5000 });
        const score = rug.data.score;

        if (score < 5000) {
            isPaused = true;
            bot.sendMessage(MY_ID, `🚀 DETECTED: ${tokenMint}\nScore: ${score}\nAttempting Buy...`);
            await buyToken(tokenMint);
            setTimeout(() => { isPaused = false; }, 60000); // 1 min cooldown
        }
    } catch (e) { console.log("⚠️ Filtered/Error"); }
}, 'processed');

console.log("🚀 AGGRESSIVE MASTER BOT LIVE.");
