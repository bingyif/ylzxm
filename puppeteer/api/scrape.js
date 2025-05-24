// api/scrape.js
const puppeteer = require('puppeteer-core');
const chromeLambda = require('chrome-aws-lambda');
const puppeteerExtra = require('puppeteer-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const UserAgent = require('user-agents');
const proxyChain = require('proxy-chain');
const fetch = require('node-fetch');

// 启用 stealth，并移除丢失的 chrome.app evasion
const stealth = stealthPlugin();
stealth.enabledEvasions.delete('chrome.app');
puppeteerExtra.use(stealth);

const config = {
  headless: true,
  proxyEnabled: false,
  proxyAPI: 'http://api.proxy.ipidea.io/getBalanceProxyIp?num=10&return_type=txt&lb=1&sb=0&flow=1&regions=&protocol=http',
  blockResources: ['image', 'stylesheet', 'font', 'media', 'script'],
  timeout: 30000,
  defaultTab: 'home',
  defaultPerPage: 10,
  viewport: { width: 1920, height: 1080 },
  browserArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1920,1080'
  ]
};

function isValidUrl(u) {
  try { return Boolean(new URL(u)); }
  catch { return false; }
}

function generateTraceId() {
  return `00-${Math.random().toString(16).slice(2, 18)}-${Date.now().toString(16)}-00`;
}

async function fetchProxyList() {
  try {
    const response = await fetch(config.proxyAPI);
    if (!response.ok) throw new Error(`Proxy API Error: ${response.status}`);
    return response.text().then(t => t.trim().split('\n').filter(Boolean));
  } catch {
    return [];
  }
}

async function createBrowser(useProxy) {
  const baseConfig = {
    headless: config.headless,
    args: [...config.browserArgs, ...chromeLambda.args],
    ignoreHTTPSErrors: true,
    defaultViewport: config.viewport,
    executablePath: await chromeLambda.executablePath
  };

  if (useProxy && config.proxyEnabled) {
    const proxies = await fetchProxyList();
    if (proxies.length > 0) {
      const proxyUrl = await proxyChain.anonymizeProxy(proxies[0]);
      baseConfig.args.push(`--proxy-server=${proxyUrl}`);
    }
  }

  return puppeteerExtra.launch(baseConfig);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method Not Allowed');
  }

  const { url, timeout = config.timeout, proxy = 'false' } = req.query;
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({
      error: 'Invalid URL',
      traceId: generateTraceId()
    });
  }

  const useProxy = ['true', '1', 'yes'].includes(proxy.toLowerCase());
  let browser = null;

  try {
    browser = await createBrowser(useProxy);
    const page = await browser.newPage();
    await page.setUserAgent(new UserAgent().toString());
    await page.setDefaultNavigationTimeout(Number(timeout));

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (config.blockResources.includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const html = await page.content();

    res.status(200).type('html').send(html);
  } catch (err) {
    res.status(500).json({
      error: 'Crawling Failed',
      reason: err.message,
      traceId: generateTraceId()
    });
  } finally {
    if (browser) await browser.close();
  }
};
