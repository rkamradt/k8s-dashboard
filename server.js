const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_MS = parseInt(process.env.CACHE_MS || '15000');

// Only return full pod details (including names) for these namespaces.
// All other namespaces are collapsed to a per-namespace count in hiddenPodCounts.
const SHOWCASE_NAMESPACES = new Set([
  'home', 'k8s-dashboard', 'gol', 'portfolio', 'llm', 'cluster-ops-agent',
  'clodapp', 'rkamradt-platform', 'receipts', 'blackbook', 'javaman',
  'naivefront', 'simcity-lite', 'monitoring',
]);

// In-cluster service account credentials
let k8sToken = null;
let k8sAgent = null;
try {
  k8sToken = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
  const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
  k8sAgent = new https.Agent({ ca });
  console.log('In-cluster Kubernetes credentials loaded');
} catch (e) {
  console.warn('No in-cluster credentials — k8s API unavailable');
}

function k8sGet(apiPath) {
  return new Promise((resolve, reject) => {
    if (!k8sToken) return reject(new Error('No k8s credentials'));
    const req = https.get({
      hostname: 'kubernetes.default.svc',
      path: apiPath,
      headers: { Authorization: `Bearer ${k8sToken}` },
      agent: k8sAgent,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${apiPath}`)); }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error(`Timeout: ${apiPath}`)));
    req.on('error', reject);
  });
}

function parseCPU(str) {
  if (!str) return 0;
  if (str.endsWith('n')) return parseInt(str) / 1e9;
  if (str.endsWith('m')) return parseInt(str) / 1000;
  return parseFloat(str) || 0;
}

function parseMemory(str) {
  if (!str) return 0;
  if (str.endsWith('Ki')) return parseInt(str) * 1024;
  if (str.endsWith('Mi')) return parseInt(str) * 1024 * 1024;
  if (str.endsWith('Gi')) return parseInt(str) * 1024 * 1024 * 1024;
  if (str.endsWith('Ti')) return parseInt(str) * 1024 * 1024 * 1024 * 1024;
  return parseInt(str) || 0;
}

async function getClusterData() {
  const [nodesRes, podsRes, deploymentsRes, namespacesRes] = await Promise.all([
    k8sGet('/api/v1/nodes'),
    k8sGet('/api/v1/pods'),
    k8sGet('/apis/apps/v1/deployments'),
    k8sGet('/api/v1/namespaces'),
  ]);

  // Metrics-server is optional — degrade gracefully if absent
  let nodeMetrics = {};
  try {
    const nm = await k8sGet('/apis/metrics.k8s.io/v1beta1/nodes');
    for (const item of (nm.items || [])) {
      nodeMetrics[item.metadata.name] = {
        cpu: parseCPU(item.usage?.cpu),
        memory: parseMemory(item.usage?.memory),
      };
    }
  } catch (_) {}

  const nodes = (nodesRes.items || []).map(n => {
    const capacity = n.status?.capacity || {};
    const ready = (n.status?.conditions || []).find(c => c.type === 'Ready')?.status === 'True';
    return {
      name: n.metadata.name,
      ready,
      cpuCapacity: parseCPU(capacity.cpu),
      memCapacity: parseMemory(capacity.memory),
      metrics: nodeMetrics[n.metadata.name] || null,
      creationTimestamp: n.metadata.creationTimestamp,
    };
  });

  const pods = (podsRes.items || []).map(p => {
    const containerStatuses = p.status?.containerStatuses || [];
    const allStatuses = [...containerStatuses, ...(p.status?.initContainerStatuses || [])];
    const restarts = allStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);
    const ready = containerStatuses.length > 0 && containerStatuses.every(c => c.ready);

    let status = p.status?.phase || 'Unknown';
    if (p.metadata.deletionTimestamp) {
      status = 'Terminating';
    } else if (status === 'Running' && !ready) {
      const waitingReason = containerStatuses[0]?.state?.waiting?.reason;
      status = waitingReason || 'NotReady';
    }

    return {
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      status,
      restarts,
      node: p.spec?.nodeName,
      startTime: p.status?.startTime,
    };
  });

  const namespaces = (namespacesRes.items || []).map(ns => ns.metadata.name);

  const deployments = (deploymentsRes.items || []).map(d => ({
    name: d.metadata.name,
    namespace: d.metadata.namespace,
    desired: d.spec?.replicas || 0,
    ready: d.status?.readyReplicas || 0,
  }));

  // Split pods: full details only for showcase namespaces; counts for the rest.
  const showcasePods = pods.filter(p => SHOWCASE_NAMESPACES.has(p.namespace));
  const hiddenPodCounts = {};
  for (const p of pods) {
    if (!SHOWCASE_NAMESPACES.has(p.namespace)) {
      hiddenPodCounts[p.namespace] = (hiddenPodCounts[p.namespace] || 0) + 1;
    }
  }

  return { nodes, pods: showcasePods, hiddenPodCounts, namespaces, deployments, timestamp: new Date().toISOString() };
}

let cache = null;
let cacheTime = 0;

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/cluster', async (req, res) => {
  const now = Date.now();
  if (!cache || now - cacheTime > CACHE_MS) {
    try {
      cache = await getClusterData();
      cacheTime = now;
      console.log(`cluster data refreshed: ${cache.pods.length} pods, ${cache.nodes.length} nodes`);
    } catch (err) {
      console.error('k8s fetch error:', err.message);
      if (!cache) return res.status(503).json({ error: 'Cluster data unavailable', detail: err.message });
    }
  }
  res.json({ ...cache, cacheAge: Math.floor((Date.now() - cacheTime) / 1000) });
});

app.listen(PORT, () => console.log(`k8s-dashboard listening on ${PORT}`));
