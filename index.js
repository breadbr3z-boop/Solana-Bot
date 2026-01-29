const { Connection, PublicKey, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const http = require('http'); 
const bs58 = require('bs58').default || require('bs58'); 
require('dotenv').config();

// 🛡️ KEEP-ALIVE SERVER
http.createServer((req, res) => { res.writeHead(200); res.end('DOMINANCE_ACTIVE'); }).listen(process.env.PORT || 8080);

const connection = new Connection(process.env.RPC_URL, { commitment: 'processed' }); // Faster commitment
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN.trim(), { polling: true });
const MY_ID = process.env.CHAT_ID;

const RAY_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL_MINT = "So11111111111111111111111111111111111111112";

let isWorking = false;

// 📝 HIGH-PRECISION LOGGING
function diagLog(msg) {
    const time = new Date().toISOString().split('T')[1].split('Z')[0];
    console.log(`[${time}] ${msg}`);
}

async function totalDominanceStrike(mint) {
    diagLog(`🎯 INITIATING MAX STRIKE: ${mint}`);
    
    try {
        // 1. GET QUOTE (Aggressive params)
        const quoteStart = Date.now();
        const { data: quote } = await axios.get(`https://quote-api.jup.ag/v6/quote`, {
            params: {
                inputMint: SOL_MINT,
                outputMint: mint,
                amount: 0.01 * LAMPORTS_PER_SOL,
                slippageBps: 9900, // 99% Slippage - Buy at any price
                onlyDirectRoutes: true,
                maxAccounts: 20
            },
            timeout: 2000
        });
        diagLog(`⏱️ Quote fetched in ${Date.now() - quoteStart}ms`);

        // 2. BUILD SWAP
        const { data: swap } = await axios.post(`https://quote-api.jup.ag/v6/swap`, {
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            prioritizationFeeLamports: 10000000, // 10M Lamports (~$2.00 bribe) - Absolute Priority
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            useSharedAccounts: true
        });

        const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
        tx.sign([wallet]);
        const wireTx = tx.serialize();

        // 3. THE SHOTGUN BLAST (Send to multiple endpoints if possible)
        diagLog(`🚀 Blasting Transaction...`);
        const sig = await connection.sendRawTransaction(wireTx, {
            skipPreflight: true, // Do not simulate, just fire
            maxRetries: 10,      // Keep retrying at the RPC level
            preflightCommitment: 'processed'
        });

        bot.sendMessage(MY_ID, `🔥 MAX STRIKE SENT!\nSig: ${sig}\nCheck: https://solscan.io/tx/${sig}`);
        
        // 4. CONFIRMATION DIAGNOSTIC
        const confirmation = await connection.confirmTransaction(sig, 'confirmed');
        if (confirmation.value.err) {
            diagLog(`❌ TX FAILED ON-CHAIN: ${JSON.stringify(confirmation.value.err)}`);
        } else {
            diagLog(`✅ TX CONFIRMED!`);
        }

    } catch (e) {
        diagLog(`🚨 STRIKE ERROR: ${e.response?.data?.error || e.message}`);
        if (e.message.includes('400')) diagLog("DEBUG: Token likely not tradable yet.");
        if (e.message.includes('ENOTFOUND')) diagLog("DEBUG: DNS Failure - Railway Network Issue.");
    }
}

async function main() {
    diagLog("V31 TOTAL DOMINANCE ONLINE.");
    
    connection.onLogs(RAY_V4, async ({ signature, logs, err }) => {
        if (isWorking || err || !logs.some(l => l.toLowerCase().includes("init"))) return;
        isWorking = true;
        
        try {
            const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            const mint = tx?.meta?.postTokenBalances?.find(b => b.mint !== SOL_MINT && b.owner !== RAY_V4.toBase58())?.mint;
            
            if (mint) {
                // Skip RugCheck for "Guarantee" test - Strike everything clean
                await totalDominanceStrike(mint);
            }
        } catch (e) { diagLog(`Scanner Error: ${e.message}`); }
        
        setTimeout(() => { isWorking = false; }, 1000); 
    }, 'processed');
}

main();
