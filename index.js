const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 1. LITE SETUP
const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";

let isWorking = false;
let subIds = [];

// 2. LITE BUYER (Using Direct API calls instead of heavy SDK)
async function buyToken(mint) {
    try {
        console.log("🛒 Fetching Quote...");
        const quoteReq = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${0.01 * LAMPORTS_PER_SOL}&slippageBps=5000`);
        const quoteResponse = quoteReq.data;

        const swapReq = await axios.post('https://quote-api.jup.ag/v6/swap', {
            quoteResponse,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 100000 // Fixed priority fee to ensure it lands
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swapReq.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `✅ SNIPED!\nhttps://solscan.io/tx/${sig}`);
    } catch (e) {
        console.log("🚨 Buy Fail:", e.response?.data?.error || e.message);
    }
}

// 3. MEMORY-SAFE SCANNER
async function toggleScanning(on) {
    if (!on) {
        for (let id of subIds) await connection.removeOnLogsListener(id);
        subIds = [];
    } else {
        [RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
            const id = connection.onLogs(pId, async ({ signature, logs, err }) => {
                if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;

                isWorking = true;
                await toggleScanning(false); // Stop logs to free RAM

                console.log(`🎯 TARGET: ${signature.slice(0, 8)}`);
                try {
                    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (tx) {
                        const allAccounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
                        const mint = allAccounts.find(addr => addr !== SOL_MINT && addr !== pId.toBase58() && addr !== wallet.publicKey.toBase58() && !addr.startsWith('1111') && !addr.startsWith('Tokenkeg'));
                        
                        if (mint) {
                            console.log(`✅ PASS: ${mint.slice(0,4)}`);
                            await buyToken(mint);
                        }
                    }
                } catch (e) { }

                console.log("⏳ Cooling down 60s...");
                setTimeout(async () => {
                    isWorking = false;
                    await toggleScanning(true);
                }, 60000);
            }, 'processed');
            subIds.push(id);
        });
    }
}

process.on('uncaughtException', () => { isWorking = false; toggleScanning(true); });

console.log("🚀 LITE APEX ENGINE ONLINE.");
toggleScanning(true);
