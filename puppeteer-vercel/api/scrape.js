const puppeteer = require('puppeteer-core');
const chromeLambda = require('chrome-aws-lambda');
const puppeteerExtra = require('puppeteer-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
const userAgent = require('user-agents');
const proxyChain = require('proxy-chain');
const fetch = require('node-fetch');

puppeteerExtra.use(stealthPlugin());

const config = {
  headless: true,
  proxyEnabled: false,
  proxyAPI: 'http://api.proxy.ipidea.io/getBalanceProxyIp?num=10&return_type=txt&lb=1&sb=0&flow=1&regions=&protocol=http',
  blockResources: ['image', 'stylesheet', 'font', 'media', 'script'],
  timeout: 30000,
  retries: 3,
  validTabs: ['home', 'products', 'contact', 'about'],
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

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
  const { url, timeout = '', proxy = '', activeTab = config.defaultTab, recordPerPage = config.defaultPerPage } = req.query;

  function isValidUrl(u) {
    try { return Boolean(new URL(u)); } catch { return false; }
  }

  function generateTraceId() {
    return `00-${Math.random().toString(16).slice(2, 18)}-${Date.now().toString(16)}-00`;
  }

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL', traceId: generateTraceId() });
  }

  async function fetchProxyList() {
    try {
      const response = await fetch(config.proxyAPI);
      if (!response.ok) throw new Error(`Proxy API Error: ${response.status}`);
      return response.text().then(text => text.trim().split('\n').filter(Boolean));
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

  try {
    const browser = await createBrowser(!['false','0','no'].includes(proxy.toLowerCase()));
    const page = await browser.newPage();
    const ua = new userAgent({ deviceCategory: 'desktop' });
    await page.setUserAgent(ua.toString());

    await page.setRequestInterception(true);
    page.on('request', req => {
      if (config.blockResources.includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(url, { timeout: Math.min(+timeout || config.timeout, 60000), waitUntil: 'domcontentloaded' });

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    await browser.close();

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
  } catch (e) {
    res.status(500).json({ error: 'Crawling Failed', reason: e.message, traceId: generateTraceId() });
  }
};
