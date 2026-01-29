const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const jupiter = createJupiterApiClient(); 
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";

let isWorking = false; 
let subscriptionIds = [];

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// 1. DYNAMIC SUBSCRIPTION CONTROL (Clears memory during buys)
async function toggleScanning(on) {
    if (!on) {
        for (let id of subscriptionIds) await connection.removeOnLogsListener(id);
        subscriptionIds = [];
        console.log("⏸️ SCANNER PAUSED: Clearing memory for Execution.");
    } else {
        startScanner();
    }
}

// 2. BUYER & MONITOR
async function buyToken(mint) {
    try {
        const quote = await jupiter.quoteGet({ inputMint: SOL_MINT, outputMint: mint, amount: (0.01 * LAMPORTS_PER_SOL).toString(), slippageBps: 5000 });
        if (!quote) return;
        const { swapTransaction } = await jupiter.swapPost({ swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" } });
        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        bot.sendMessage(MY_ID, `🚀 SNIPE! https://solscan.io/tx/${sig}`);
    } catch (e) { console.log("🚨 Execution Error"); }
}

// 3. THE CORE SCANNER
function startScanner() {
    [RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
        const subId = connection.onLogs(pId, async ({ logs, signature, err }) => {
            if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;

            isWorking = true; 
            await toggleScanning(false); // SHUT DOWN firehose immediately to save RAM

            console.log(`🎯 TARGET: ${signature.slice(0, 8)}`);
            try {
                let tx = null;
                for (let i = 0; i < 4; i++) {
                    tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
                    if (tx) break;
                    await delay(3000);
                }

                if (tx) {
                    const allAccounts = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
                    let mint = allAccounts.find(addr => addr !== SOL_MINT && addr !== pId.toBase58() && addr !== wallet.publicKey.toBase58() && !addr.startsWith('1111') && !addr.startsWith('Tokenkeg'));
                    
                    if (mint) {
                        const info = await connection.getAccountInfo(new PublicKey(mint)).catch(() => null);
                        if (info) {
                            console.log(`✅ PASS: ${mint.slice(0,4)}`);
                            await buyToken(mint);
                        }
                    }
                }
            } catch (e) { }

            console.log("⏳ Cooling down 60s...");
            await delay(60000);
            isWorking = false;
            await toggleScanning(true); // Restart firehose
        }, 'processed');
        subscriptionIds.push(subId);
    });
}

process.on('uncaughtException', (err) => { console.log('🛡️ Blocked Crash:', err.message); isWorking = false; toggleScanning(true); });

console.log("🚀 MEMORY-SHIELDED APEX LIVE.");
startScanner();
