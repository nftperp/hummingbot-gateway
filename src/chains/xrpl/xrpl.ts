import {
  Client,
  Wallet,
  LedgerStream,
  ValidationStream,
  TransactionStream,
  PeerStatusStream,
  ConsensusStream,
  PathFindStream,
  TxResponse,
  TransactionMetadata,
} from 'xrpl';
import axios from 'axios';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import fse from 'fs-extra';
import path from 'path';
import { rootPath } from '../../paths';
import { TokenListType, walletPath, MarketListType } from '../../services/base';
import { ConfigManagerCertPassphrase } from '../../services/config-manager-cert-passphrase';
import { getXRPLConfig } from './xrpl.config';
// import { logger } from '../../services/logger';
import { TransactionResponseStatusCode } from './xrpl.requests';
import { XRPLOrderStorage } from './xrpl.order-storage';
import { OrderTracker } from './xrpl.order-tracker';
import { ReferenceCountingCloseable } from '../../services/refcounting-closeable';
import { XRPLController } from './xrpl.controllers';

export type TokenInfo = {
  id: number;
  code: string;
  issuer: string;
  title: string;
  trustlines: number;
  placeInTop: null;
};

export type MarketInfo = {
  id: number;
  marketId: string;
  baseIssuer: string;
  quoteIssuer: string;
  baseTokenID: number;
  quoteTokenID: number;
};

export type TokenBalance = {
  currency: string;
  issuer?: string;
  value: string;
};

export type Fee = {
  base: string;
  median: string;
  minimum: string;
  openLedger: string;
};

export class XRPL implements XRPLish {
  private static _instances: { [name: string]: XRPL };
  public rpcUrl;
  public fee: Fee;

  protected tokenList: TokenInfo[] = [];
  protected marketList: MarketInfo[] = [];
  private _tokenMap: Record<string, TokenInfo[]> = {};
  private _marketMap: Record<string, MarketInfo[]> = {};

  private _client: Client;
  private _nativeTokenSymbol: string;
  private _chain: string;
  private _network: string;
  private _requestCount: number;
  private _metricsLogInterval: number;
  private _tokenListSource: string;
  private _marketListSource: string;
  private _tokenListType: TokenListType;
  private _marketListType: MarketListType;

  private _ready: boolean = false;
  private initializing: boolean = false;

  private readonly _refCountingHandle: string;
  private readonly _orderStorage: XRPLOrderStorage;

  public controller: typeof XRPLController;

  private constructor(network: string) {
    const config = getXRPLConfig('xrpl', network);

    this._chain = 'xrpl';
    this._network = network;
    this.rpcUrl = config.network.nodeUrl;
    this._nativeTokenSymbol = config.network.nativeCurrencySymbol;
    this._tokenListSource = config.network.tokenListSource;
    this._tokenListType = <TokenListType>config.network.tokenListType;
    this._marketListSource = config.network.marketListSource;
    this._marketListType = <MarketListType>config.network.marketListType;

    this._client = new Client(this.rpcUrl, {
      timeout: config.requestTimeout,
      connectionTimeout: config.connectionTimeout,
      feeCushion: config.feeCushion,
      maxFeeXRP: config.maxFeeXRP,
    });

    this.fee = {
      base: '0',
      median: '0',
      minimum: '0',
      openLedger: '0',
    };

    this._requestCount = 0;
    this._metricsLogInterval = 300000; // 5 minutes

    this.onValidationReceived(this.requestCounter.bind(this));
    // setInterval(this.metricLogger.bind(this), this.metricsLogInterval);

    this._refCountingHandle = ReferenceCountingCloseable.createHandle();
    this._orderStorage = XRPLOrderStorage.getInstance(
      this.resolveDBPath(config.orderDbPath),
      this._refCountingHandle
    );
    this._orderStorage.declareOwnership(this._refCountingHandle);
    this.controller = XRPLController;
  }

  public static getInstance(network: string): XRPL {
    if (XRPL._instances === undefined) {
      XRPL._instances = {};
    }
    if (!(network in XRPL._instances)) {
      XRPL._instances[network] = new XRPL(network);
    }

    return XRPL._instances[network];
  }

  public static getConnectedInstances(): { [name: string]: XRPL } {
    return XRPL._instances;
  }

  public resolveDBPath(oldPath: string): string {
    if (oldPath.charAt(0) === '/') return oldPath;
    const dbDir: string = path.join(rootPath(), 'db/');
    fse.mkdirSync(dbDir, { recursive: true });
    return path.join(dbDir, oldPath);
  }

  public get client() {
    return this._client;
  }

  public onConnected(callback: () => void) {
    this._client.on('connected', callback);
  }

  public onDisconnected(callback: (code: number) => void) {
    this._client.on('disconnected', callback);
  }

  public onLedgerClosed(callback: (ledger: LedgerStream) => void) {
    this._client.on('ledgerClosed', callback);
  }

  public onValidationReceived(
    callback: (validation: ValidationStream) => void
  ) {
    this._client.on('validationReceived', callback);
  }

  public onTransaction(callback: (tx: TransactionStream) => void) {
    this._client.on('transaction', callback);
  }

  public onPeerStatusChange(callback: (status: PeerStatusStream) => void) {
    this._client.on('peerStatusChange', callback);
  }

  public onConsensusPhase(callback: (phase: ConsensusStream) => void) {
    this._client.on('consensusPhase', callback);
  }

  public onPathFind(callback: (path: PathFindStream) => void) {
    this._client.on('path_find', callback);
  }

  public onError(callback: (...err: any[]) => void): void {
    this._client.on('error', callback);
  }

  async init(): Promise<void> {
    if (!this.ready() && !this.initializing) {
      this.initializing = true;
      await this.ensureConnection();
      await this.loadTokens(this._tokenListSource, this._tokenListType);
      await this.loadMarkets(this._marketListSource, this._marketListType);
      await this.getFee();
      await this._orderStorage.init();
      this._ready = true;
      this.initializing = false;
    }
  }

  async loadTokens(
    tokenListSource: string,
    tokenListType: TokenListType
  ): Promise<void> {
    this.tokenList = await this.getTokenList(tokenListSource, tokenListType);
    if (this.tokenList) {
      this.tokenList.forEach((token: TokenInfo) => {
        if (!this._tokenMap[token.code]) {
          this._tokenMap[token.code] = [];
        }

        this._tokenMap[token.code].push(token);
      });
    }
  }

  async loadMarkets(
    marketListSource: string,
    marketListType: MarketListType
  ): Promise<void> {
    this.marketList = await this.getMarketList(
      marketListSource,
      marketListType
    );
    if (this.marketList) {
      this.marketList.forEach((market: MarketInfo) => {
        if (!this._marketMap[market.marketId]) {
          this._marketMap[market.marketId] = [];
        }

        this._marketMap[market.marketId].push(market);
      });
    }
  }

  async getTokenList(
    tokenListSource: string,
    tokenListType: TokenListType
  ): Promise<TokenInfo[]> {
    let tokens;
    if (tokenListType === 'URL') {
      ({
        data: { tokens },
      } = await axios.get(tokenListSource));
    } else {
      ({ tokens } = JSON.parse(await fs.readFile(tokenListSource, 'utf8')));
    }
    return tokens;
  }

  async getMarketList(
    marketListSource: string,
    marketListType: TokenListType
  ): Promise<MarketInfo[]> {
    let tokens;
    if (marketListType === 'URL') {
      const resp = await axios.get(marketListSource);
      tokens = resp.data.tokens;
    } else {
      tokens = JSON.parse(await fs.readFile(marketListSource, 'utf8'));
    }
    return tokens;
  }

  public get storedTokenList(): TokenInfo[] {
    return this.tokenList;
  }

  public get storedMarketList(): MarketInfo[] {
    return this.marketList;
  }

  public getTokenForSymbol(code: string): TokenInfo[] | null {
    return this._tokenMap[code] ? this._tokenMap[code] : null;
  }

  public getWalletFromSeed(seed: string): Wallet {
    const wallet = Wallet.fromSeed(seed);

    return wallet;
  }

  async getWallet(address: string): Promise<Wallet> {
    const path = `${walletPath}/${this.chain}`;

    const encryptedSeed: string = await fse.readFile(
      `${path}/${address}.json`,
      'utf8'
    );

    const passphrase = ConfigManagerCertPassphrase.readPassphrase();
    if (!passphrase) {
      throw new Error('missing passphrase');
    }
    const decrypted = await this.decrypt(encryptedSeed, passphrase);

    return Wallet.fromSeed(decrypted);
  }

  async encrypt(secret: string, password: string): Promise<string> {
    const algorithm = 'aes-256-ctr';
    const iv = crypto.randomBytes(16);
    const salt = crypto.randomBytes(32);
    const key = crypto.pbkdf2Sync(password, salt, 5000, 32, 'sha512');
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);

    const ivJSON = iv.toJSON();
    const saltJSON = salt.toJSON();
    const encryptedJSON = encrypted.toJSON();

    return JSON.stringify({
      algorithm,
      iv: ivJSON,
      salt: saltJSON,
      encrypted: encryptedJSON,
    });
  }

  async decrypt(encryptedSecret: string, password: string): Promise<string> {
    const hash = JSON.parse(encryptedSecret);
    const salt = Buffer.from(hash.salt, 'utf8');
    const iv = Buffer.from(hash.iv, 'utf8');

    const key = crypto.pbkdf2Sync(password, salt, 5000, 32, 'sha512');

    const decipher = crypto.createDecipheriv(hash.algorithm, key, iv);

    const decrpyted = Buffer.concat([
      decipher.update(Buffer.from(hash.encrypted, 'hex')),
      decipher.final(),
    ]);

    return decrpyted.toString();
  }

  async getNativeBalance(wallet: Wallet): Promise<string> {
    await this.ensureConnection();
    const balance = await this._client.getXrpBalance(wallet.address);
    return balance;
  }

  async getAllBalance(wallet: Wallet): Promise<Record<string, string>> {
    await this.ensureConnection();
    const balances: Record<string, string> = {};
    const respBalances = await this._client.getBalances(wallet.address);

    respBalances.forEach((token) => {
      if (token.currency === 'XRP') {
        balances[token.currency] = token.value;
      } else {
        const symbol = token.currency + '.' + token.issuer;
        balances[symbol] = token.value;
      }
    });

    return balances;
  }

  ready(): boolean {
    return this._ready;
  }

  isConnected(): boolean {
    return this._client.isConnected();
  }

  async ensureConnection() {
    if (!this.isConnected()) {
      await this._client.connect();
    }
  }

  public get chain(): string {
    return this._chain;
  }

  public get network(): string {
    return this._network;
  }

  public get nativeTokenSymbol(): string {
    return this._nativeTokenSymbol;
  }

  public requestCounter(): void {
    this._requestCount += 1;
  }

  // public metricLogger(): void {
  //   logger.info(
  //     this.requestCount +
  //       ' request(s) sent in last ' +
  //       this.metricsLogInterval / 1000 +
  //       ' seconds.'
  //   );
  //   this._requestCount = 0; // reset
  // }

  public get requestCount(): number {
    return this._requestCount;
  }

  public get metricsLogInterval(): number {
    return this._metricsLogInterval;
  }

  public async getCurrentLedgerIndex(): Promise<number> {
    await this.ensureConnection();
    const currentIndex = await this.client.getLedgerIndex();
    return currentIndex;
  }

  public async getCurrentBlockNumber(): Promise<number> {
    await this.ensureConnection();
    const currentIndex = await this.getCurrentLedgerIndex();
    return currentIndex;
  }

  public async getTransactionStatusCode(
    txData: TxResponse | null
  ): Promise<TransactionResponseStatusCode> {
    let txStatus;
    if (!txData) {
      txStatus = TransactionResponseStatusCode.FAILED;
    } else {
      if ((<TransactionMetadata>txData.result.meta).TransactionResult) {
        const result = (<TransactionMetadata>txData.result.meta)
          .TransactionResult;
        txStatus =
          result == 'tesSUCCESS'
            ? TransactionResponseStatusCode.CONFIRMED
            : TransactionResponseStatusCode.FAILED;
      } else {
        txStatus = TransactionResponseStatusCode.FAILED;
      }
    }
    return txStatus;
  }

  async getTransaction(txHash: string): Promise<TxResponse | null> {
    await this.ensureConnection();
    const tx_resp = await this._client.request({
      command: 'tx',
      transaction: txHash,
      binary: false,
    });

    const result = tx_resp;

    return result;
  }

  async close() {
    if (this._network in XRPL._instances) {
      await OrderTracker.stopTrackingOnAllInstancesForNetwork(this._network);
      await this._orderStorage.close(this._refCountingHandle);
      delete XRPL._instances[this._network];
    }
  }

  async getFee() {
    await this.ensureConnection();
    const tx_resp = await this._client.request({
      command: 'fee',
    });

    this.fee = {
      base: tx_resp.result.drops.base_fee,
      median: tx_resp.result.drops.median_fee,
      minimum: tx_resp.result.drops.minimum_fee,
      openLedger: tx_resp.result.drops.open_ledger_fee,
    };

    return this.fee;
  }

  public get orderStorage(): XRPLOrderStorage {
    return this._orderStorage;
  }
}

export type XRPLish = XRPL;
export const XRPLish = XRPL;
