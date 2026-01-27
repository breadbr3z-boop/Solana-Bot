const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
// This line is now fixed to handle both old and new versions of the library
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

// 2. BUY FUNCTION
async function buyToken(mint, amountSol = 0.1) {
    try {
        const quote = await jupiter.quoteGet({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: mint,
            amount: amountSol * 1e9,
            slippageBps: 1500, // 15% slippage
        });

        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true }
        });

        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        transaction.sign([wallet]);

        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `✅ BOUGHT NEW TOKEN: ${mint}\nTx: https://solscan.io/tx/${signature}`);
    } catch (e) {
        console.error("Trade Failed:", e.message);
    }
}

// 3. SCANNER & RUGCHECK
connection.onLogs(RAYDIUM_ID, async ({ logs, signature, err }) => {
    if (err || !logs.some(log => log.includes("initialize2"))) return;

    try {
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        const instructions = tx?.transaction.message.instructions;
        const raydiumIx = instructions.find(ix => ix.programId.equals(RAYDIUM_ID));
        
        if (!raydiumIx || !raydiumIx.accounts) return;
        const tokenMint = raydiumIx.accounts[8].toBase58();

        // 🛡️ RugCheck Safety Check
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`);
        if (rug.data.score < 500) {
            bot.sendMessage(MY_ID, `💎 Safe Token Found: ${tokenMint}\nRugCheck Score: ${rug.data.score}\nAttempting to buy 0.1 SOL...`);
            await buyToken(tokenMint);
        }
    } catch (e) {
        console.log("Scanning for new launches...");
    }
}, 'confirmed');

// Startup confirmation message
bot.sendMessage(MY_ID, "✅ Bot successfully connected to Railway! Starting Solana market scan...");
