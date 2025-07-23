import Redis from 'ioredis';

const {
  REDIS_URL,
  WORKER_URL,
  MIN_SWAP_USD = '5000',
  HF_TOKEN
} = process.env;

// Global fetch available
const redis = new Redis(REDIS_URL);

export async function handler(event) {
  try {
    // Parse incoming body for test mode
    const body = event.body ? JSON.parse(event.body) : {};
    let swap;
    let testMode = false;

    if (body.swap) {
      swap = body.swap;
      testMode = true;
      console.log('🔧 Test mode active, using provided swap:', swap);
    } else {
      // Real mode: fetch swaps
      const resp = await fetch('https://public-api.birdeye.so/public/token/all/recent_swaps', {
        headers: { 'x-chain': 'solana' }
      });
      const { data = [] } = await resp.json();
      if (!data.length) return ok('No hay swaps recientes');
      const threshold = parseFloat(MIN_SWAP_USD);
      const grandes = data.filter(s => s.amountUsd >= threshold);
      if (!grandes.length) return ok(`No hay swaps ≥ $${threshold}`);
      swap = grandes.sort((a, b) => b.amountUsd - a.amountUsd)[0];
    }

    const tx = swap.txSignature;

    // Deduplication
    if (!testMode && await redis.exists(tx)) return ok(`Swap ${tx} ya procesado`);

    // Whale detection and caching
    let tags = ['#Solana'];
    if (!testMode) {
      const keyPattern = `wallet:${swap.userAddress}:*`;
      const prev = await redis.keys(keyPattern);
      if (prev.length >= 2) tags.push('#whale');
      const ts = Math.floor(Date.now()/1000);
      await redis.set(`wallet:${swap.userAddress}:${ts}`, tx, 'EX', 600);
    }

    // Sentiment analysis only in real mode
    let score = 1.0;
    if (!testMode) {
      if (!HF_TOKEN) throw new Error('HF_TOKEN missing');
      const hfResp = await fetch(
        'https://api-inference.huggingface.co/models/finiteautomata/bertweet-base-sentiment-analysis',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: `${swap.tokenSymbol} volumen ${swap.amountUsd}` })
        }
      );
      if (!hfResp.ok) throw new Error(`Hugging Face error: ${hfResp.status}`);
      const arr = await hfResp.json();
      score = arr[0]?.score ?? 0;
      if (score < 0.7) return ok(`Score IA bajo (${score.toFixed(2)})`);
    }

    // Build payload
    const payload = {
      analisis: {
        token: swap.tokenSymbol,
        volumen: swap.amountUsd,
        score,
        tags,
        comentario: testMode ? 'Test mode run' : `Swap ${swap.tokenSymbol} por $${swap.amountUsd}`
      }
    };

    console.log('📤 Payload:', payload);
    await fetch(WORKER_URL, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(payload) });

    if (!testMode) await redis.set(tx, 'ok', 'EX', 600);
    return ok(`Swap ${tx} enviado`);
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
}

function ok(msg) { return { statusCode: 200, body: msg }; }
