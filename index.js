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

console.log("🚀 Auto-Trader Started on Railway...");

// 2. BUY FUNCTION (Updated with Detailed Error Reporting)
async function buyToken(mint, amountSol = 0.05) {
    try {
        console.log(`📡 Requesting quote for ${mint}...`);
        
        // Convert SOL to Lamports (Jupiter needs a string)
        const amountInLamports = Math.floor(amountSol * 1e9).toString();

        const quote = await jupiter.quoteGet({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: mint,
            amount: amountInLamports,
            slippageBps: 2000, // 20% slippage for volatile launches
        });

        if (!quote) {
            console.log("❌ Jupiter couldn't find a route for this token yet.");
            return;
        }

        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { 
                quoteResponse: quote, 
                userPublicKey: wallet.publicKey.toBase58(), 
                wrapAndUnwrapSol: true 
            }
        });

        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        transaction.sign([wallet]);

        const signature = await connection.sendRawTransaction(transaction.serialize(), { 
            skipPreflight: true, 
            maxRetries: 2 
        });

        bot.sendMessage(MY_ID, `✅ SUCCESS! Bought ${mint}\nhttps://solscan.io/tx/${signature}`);
        console.log(`✅ Trade successful: ${signature}`);
    } catch (e) {
        // Capture specific API errors from Jupiter
        const errorData = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error("🚨 Jupiter API Error:", errorData);
        
        // Send a simplified version to Telegram so you know what happened
        if (errorData.includes("COULD_NOT_FIND_ANY_ROUTE")) {
            bot.sendMessage(MY_ID, `⚠️ Trade Skipped: Token too new for Jupiter to route.`);
        } else {
            bot.sendMessage(MY_ID, `⚠️ Trade Failed: ${errorData.slice(0, 100)}`);
        }
    }
}

// 3. MAIN SCANNER
connection.onLogs(RAYDIUM_ID, async ({ logs, signature, err }) => {
    if (err || !logs.some(log => log.includes("initialize2"))) return;

    try {
        console.log("🔍 New Launch Detected! Checking safety...");
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        const instructions = tx?.transaction.message.instructions;
        const raydiumIx = instructions.find(ix => ix.programId.equals(RAYDIUM_ID));
        
        if (!raydiumIx || !raydiumIx.accounts) return;
        const tokenMint = raydiumIx.accounts[8].toBase58();

        // 🛡️ RugCheck Safety Check
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const score = rug.data.score;
        console.log(`🛡️ Token: ${tokenMint} | Score: ${score}`);

        if (score < 500) {
            bot.sendMessage(MY_ID, `💎 Safe Token Found: ${tokenMint}\nScore: ${score}\nAttempting to buy 0.05 SOL...`);
            await buyToken(tokenMint);
        } else {
            console.log(`❌ Skipped: High Rug Score (${score})`);
        }
    } catch (e) {
        console.log("Scanning for new launches...");
    }
}, 'confirmed');

// 4. HEARTBEAT & STARTUP
bot.sendMessage(MY_ID, "✅ Bot Live & Scanning Solana Market!");

setInterval(() => {
    console.log("💓 Heartbeat: Bot is still scanning Solana...");
}, 60000);
