const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

const connection = new Connection(process.env.RPC_URL, { wsEndpoint: process.env.WSS_URL, commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const RAYDIUM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM_ID = new PublicKey('CAMMCzoKmcEB3snv69UC796S3hZpkS7vBrN3shvkk9A'); 
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_IP = "https://74.125.22.103"; 

let isWorking = false;
let subIds = [];

// 🎯 AUTO-SELL WATCHDOG
async function monitorPrice(mint, entryPrice, tokens) {
    const interval = setInterval(async () => {
        try {
            const res = await axios.get(`${JUP_IP}/v6/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${tokens}&slippageBps=100`, { headers: { 'Host': 'quote-api.jup.ag' } });
            const currentPrice = parseFloat(res.data.outAmount) / tokens;
            if (currentPrice >= entryPrice * 1.5 || currentPrice <= entryPrice * 0.7) {
                clearInterval(interval);
                const swap = await axios.post(`${JUP_IP}/v6/swap`, { 
                    quoteResponse: res.data, 
                    userPublicKey: wallet.publicKey.toBase58(), 
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 300000 
                }, { headers: { 'Host': 'quote-api.jup.ag' } });
                const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
                tx.sign([wallet]);
                await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                bot.sendMessage(MY_ID, `🎯 AUTO-SELL: ${currentPrice >= entryPrice * 1.5 ? "TAKE PROFIT" : "STOP LOSS"}`);
            }
        } catch (e) { }
    }, 20000); 
}

// 🚀 THE BULLETPROOF BUYER
async function buyToken(mint) {
    try {
        console.log(`🛡️ Vetting ${mint.slice(0, 8)}`);
        const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeout: 5000 });
        if (rug.data.score > 500) return console.log(`⚠️ Skip: Score ${rug.data.score}`);

        const amount = Math.floor(0.01 * LAMPORTS_PER_SOL);
        let quote = null;

        // Indexing loop
        for (let i = 0; i < 6; i++) {
            try {
                const res = await axios.get(`${JUP_IP}/v6/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${amount}&slippageBps=1000`, { 
                    headers: { 'Host': 'quote-api.jup.ag', 'User-Agent': 'Mozilla/5.0' } 
                });
                quote = res.data;
                break; 
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }

        if (!quote) throw new Error("Indexing timeout");

        // 🛠️ HARDENED SWAP CALL
        const swap = await axios.post(`${JUP_IP}/v6/swap`, { 
            quoteResponse: quote, 
            userPublicKey: wallet.publicKey.toBase58(), 
            wrapAndUnwrapSol: true, 
            prioritizationFeeLamports: 500000,
            dynamicComputeUnitLimit: true, // Required for priority fees
            useSharedAccounts: true      // Reduces transaction size
        }, { 
            headers: { 
                'Host': 'quote-api.jup.ag', 
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0' 
            } 
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
        tx.sign([wallet]);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        
        bot.sendMessage(MY_ID, `💎 SNIPE SUCCESS!\nhttps://solscan.io/tx/${sig}`);
        monitorPrice(mint, amount / parseFloat(quote.outAmount), quote.outAmount);
        
    } catch (e) { 
        // 🔍 DEBUG: This will print the exact reason Jupiter says 400
        const errorDetail = e.response?.data?.error || e.response?.data?.message || e.message;
        console.log(`🚨 Buy Fail: ${errorDetail}`); 
    }
}

async function toggleScanning(on) {
    if (!on) {
        for (let id of subIds) await connection.removeOnLogsListener(id).catch(() => {});
        subIds = [];
    } else {
        [RAYDIUM_ID, RAYDIUM_CPMM_ID].forEach(pId => {
            const id = connection.onLogs(pId, async ({ signature, logs, err }) => {
                if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;
                isWorking = true;
                await toggleScanning(false); 
                try {
                    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    if (tx) {
                        const accs = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
                        const mint = accs.find(a => a !== SOL_MINT && a !== pId.toBase58() && a !== wallet.publicKey.toBase58() && !a.startsWith('1111') && !a.startsWith('Tokenkeg') && !a.startsWith('Sysvar'));
                        if (mint) await buyToken(mint);
                    }
                } catch (e) { }
                setTimeout(() => { isWorking = false; toggleScanning(true); }, 45000);
            }, 'processed');
            subIds.push(id);
        });
    }
}

process.on('uncaughtException', (err) => { isWorking = false; toggleScanning(true); });

console.log("🚀 SLEDGEHAMMER V5: THE FINAL STAND.");
toggleScanning(true);
