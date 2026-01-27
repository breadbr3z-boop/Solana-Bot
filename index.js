const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58');
require('dotenv').config();

// CONFIG
const connection = new Connection(process.env.RPC_URL, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});
const jupiter = createJupiterApiClient();
const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const MY_ID = process.env.CHAT_ID;

console.log("🚀 Auto-Trader Started on Railway...");

// 1. BUY FUNCTION
async function buyToken(mint, amountSol = 0.1) {
    try {
        const quote = await jupiter.quoteGet({
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: mint,
            amount: amountSol * 1e9,
            slippageBps: 1500, // 15% for volatile memes
        });

        const { swapTransaction } = await jupiter.swapPost({
            swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true }
        });

        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `✅ BOUGHT ${mint}\nTx: https://solscan.io/tx/${signature}`);
    } catch (e) {
        console.error("Trade Error:", e.message);
    }
}

// 2. SCANNER & RUGCHECK
connection.onLogs(RAYDIUM_PROGRAM_ID, async ({ logs, signature, err }) => {
    if (err || !logs.some(log => log.includes("initialize2"))) return;

    try {
        // Fetch transaction and extract the mint
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        const accounts = tx?.transaction.message.instructions.find(ix => ix.programId.equals(RAYDIUM_PROGRAM_ID))?.accounts;
        if (!accounts) return;

        const tokenMint = accounts[8].toBase58(); // Standard Raydium LP V4 mint index

        // Safety Check
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`);
        if (rug.data.score < 500) {
            bot.sendMessage(MY_ID, `💎 Safe Coin Found: ${tokenMint}\nScore: ${rug.data.score}\nBuying 0.1 SOL...`);
            await buyToken(tokenMint);
        }
    } catch (e) {
        console.log("Error parsing new pool.");
    }
}, 'confirmed');
