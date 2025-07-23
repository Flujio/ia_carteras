import Redis from 'ioredis';

const {
  REDIS_URL,
  WORKER_URL,
  MIN_SWAP_USD = '5000',
  HF_TOKEN
} = process.env;

const redis = new Redis(REDIS_URL);

export async function handler(event) {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    let swap;
    let testMode = false;

    if (body.swap) {
      swap = body.swap;
      testMode = true;
      console.log('🔧 Test mode active');
    } else {
      const resp = await fetch('https://public-api.birdeye.so/public/token/all/recent_swaps', {
        headers: { 'x-chain': 'solana' }
      });
      const { data = [] } = await resp.json();
      if (!data.length) return ok('No swaps');
      const threshold = parseFloat(MIN_SWAP_USD);
      swap = data.filter(s => s.amountUsd >= threshold)
                 .sort((a, b) => b.amountUsd - a.amountUsd)[0];
      if (!swap) return ok(`No swaps ≥ $${threshold}`);
    }

    const tx = swap.txSignature;

    // Deduplicación MEJORADA (SETNX)
    const dedupKey = `tx:${tx}`;
    if (await redis.set(dedupKey, "1", "EX", 600, "NX") === null) {
      return ok(`Tx ${tx} ya procesada`);
    }

    // Detección de whale
    let tags = ['#Solana'];
    if (!testMode) {
      const whaleKey = `wallet:${swap.userAddress}`;
      const whaleCount = await redis.incr(whaleKey);
      await redis.expire(whaleKey, 600);
      if (whaleCount >= 2) tags.push('#whale');
    }

    // Análisis de sentimiento MEJORADO
    let score = 1.0;
    if (!testMode) {
      const hfResp = await fetch(
        'https://api-inference.huggingface.co/models/finiteautomata/bertweet-base-sentiment-analysis',
        {
          method: 'POST',
          headers: { 
            Authorization: `Bearer ${HF_TOKEN}`, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({ 
            inputs: `Token: ${swap.tokenSymbol} | Swap: $${swap.amountUsd} USD en Solana` 
          })
        }
      );
      if (!hfResp.ok) throw new Error(`HF error: ${hfResp.status}`);
      const [result] = await hfResp.json();
      score = result?.score || 0;
      if (score < 0.7) return ok(`Score bajo (${score.toFixed(2)})`);
    }

    // Construir payload
    const payload = {
      analisis: {
        token: swap.tokenSymbol,
        volumen: swap.amountUsd,
        score,
        tags,
        comentario: testMode ? "TEST" : `Swap detectado $${swap.amountUsd}`
      }
    };

    await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    return ok(`Alerta enviada: ${swap.tokenSymbol}`);
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message };
  }
}

function ok(msg) { 
  return { 
    statusCode: 200, 
    body: JSON.stringify({ message: msg }) 
  }; 
}
