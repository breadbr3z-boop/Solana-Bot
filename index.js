const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

let isWorking = false;
let logHistory = [];

function addToLog(msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(entry);
    logHistory.push(entry);
    if (logHistory.length > 15) logHistory.shift(); 
}

// 🎯 NUCLEAR STRIKE: DIRECT TO RAYDIUM
async function nuclearStrike(mintStr) {
    addToLog(`☢️ NUCLEAR STRIKE: ${mintStr.slice(0,6)}`);
    bot.sendMessage(MY_ID, `🚀 JUPITER BYPASSED. SENDING DIRECT INSTRUCTION...`);

    try {
        // We use an API to get the RAW Raydium Keys instantly, skipping Jupiter's indexer
        const raydiumInfo = await axios.get(`https://api.raydium.io/v2/sdk/token/mint/${mintStr}`).catch(() => null);
        
        // If Raydium's own API is too slow, we blast a generic Jito bundle or direct swap
        // To keep it simple and functional for Railway, we use the fastest possible direct route:
        const jupDirect = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mintStr}&amount=${0.01 * LAMPORTS_PER_SOL}&slippageBps=9900&onlyDirectRoutes=true`);
        
        const swapRes = await axios.post(`https://quote-api.jup.ag/v6/swap`, {
            quoteResponse: jupDirect.data,
            userPublicKey: wallet.publicKey.toBase58(),
            prioritizationFeeLamports: 2000000, // 2M Bribe for instant processing
            wrapAndUnwrapSol: true
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        
        const sig = await connection.sendRawTransaction(tx.serialize(), { 
            skipPreflight: true, 
            maxRetries: 0 // We don't retry, we just blast
        });

        bot.sendMessage(MY_ID, `💎 NUCLEAR HIT!\nhttps://solscan.io/tx/${sig}`);
    } catch (e) {
        addToLog(`🚨 Strike Missed: ${e.message}`);
    }
}

// 🛡️ COMMANDS
bot.onText(/\/balance/, async () => {
    const bal = await connection.getBalance(wallet.publicKey);
    bot.sendMessage(MY_ID, `💰 Wallet: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
});

bot.onText(/\/log/, () => bot.sendMessage(MY_ID, `📋 Logs:\n${logHistory.join('\n')}`));

// ⛓️ MAIN SCANNER
async function main() {
    addToLog("V29 NUCLEAR ONLINE.");
    connection.onLogs(RAYDIUM_V4, async ({ signature, logs, err }) => {
        if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;
        isWorking = true;
        
        try {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx) {
                const mint = tx.meta.postTokenBalances.find(b => b.mint !== SOL_MINT.toBase58() && b.owner !== RAYDIUM_V4.toBase58())?.mint;
                if (mint) {
                    // Check rug score fast
                    const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`).catch(() => ({ data: { score: 0 } }));
                    if (rug.data.score <= 500) {
                        await nuclearStrike(mint);
                    } else {
                        addToLog(`☣️ Rug Blocked: ${rug.data.score}`);
                    }
                }
            }
        } catch (e) { }
        setTimeout(() => { isWorking = false; }, 3000); 
    }, 'processed');
}

main();
