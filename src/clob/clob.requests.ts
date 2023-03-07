import { NetworkSelectionRequest } from '../services/common-interfaces';
import { OrderType, Side } from '../amm/amm.requests';
import {
  FundingPayment,
  FundingRate,
  Orderbook,
  DerivativeMarket,
  SpotMarket,
  ExchangePagination,
} from '@injectivelabs/sdk-ts';

export interface ClobMarketRequest extends NetworkSelectionRequest {
  market?: string;
}

export interface CLOBMarkets {
  [key: string]: SpotMarket;
}

export interface ClobMarketResponse {
  network: string;
  timestamp: number;
  latency: number;
  markets: CLOBMarkets;
}

export type ClobTickerRequest = ClobMarketRequest;

export type ClobTickerResponse = ClobMarketResponse;

export interface ClobOrderbookRequest extends ClobMarketRequest {
  market: string;
}

export interface ClobOrderbookResponse {
  network: string;
  timestamp: number;
  latency: number;
  orderbook: Orderbook;
}

export interface ClobGetOrderRequest extends ClobOrderbookRequest {
  address: string;
  orderId: string;
}

export interface ClobGetOrderResponse {
  network: string;
  timestamp: number;
  latency: number;
  orders:
    | [
        {
          [key: string]: string;
        }
      ]
    | [];
}

export interface ClobPostOrderRequest extends ClobOrderbookRequest {
  address: string;
  side: Side;
  orderType: OrderType;
  price: string;
  amount: string;
  leverage?: number; // float
}

export interface ClobPostOrderResponse {
  network: string;
  timestamp: number;
  latency: number;
  txHash: string;
}

export type ClobDeleteOrderRequest = ClobGetOrderRequest;

export type ClobDeleteOrderResponse = ClobPostOrderResponse;

// PerpClob requests and responses

export type PerpClobMarketRequest = ClobMarketRequest;

export interface PerpClobMarkets {
  [key: string]: DerivativeMarket;
}

export interface PerpClobMarketResponse {
  network: string;
  timestamp: number;
  latency: number;
  markets: PerpClobMarkets;
}

export type PerpClobTickerRequest = PerpClobMarketRequest;

export type PerpClobTickerResponse = PerpClobMarketResponse;

export type PerpClobOrderbookRequest = ClobOrderbookRequest;

export type PerpClobOrderbookResponse = ClobOrderbookResponse;

export type PerpClobGetOrderRequest = ClobGetOrderRequest;

export type PerpClobGetOrderResponse = ClobGetOrderResponse;

export interface PerpClobPostOrderRequest extends ClobOrderbookRequest {
  address: string;
  side: Side;
  orderType: OrderType;
  price: string;
  amount: string;
  leverage: number;
}

export type PerpClobPostOrderResponse = ClobPostOrderResponse;

export type PerpClobDeleteOrderRequest = PerpClobGetOrderRequest;

export type PerpClobDeleteOrderResponse = PerpClobPostOrderResponse;

export interface PerpClobFundingRatesRequest extends NetworkSelectionRequest {
  market: string;
  skip?: number; // skip last n funding rates
  limit?: number; // 1 to 100
  endTime?: number; // Upper bound of funding rate timestamp
}

export interface PerpClobFundingRatesResponse {
  network: string;
  timestamp: number;
  latency: number;
  fundingRates: Array<FundingRate>;
  pagination: ExchangePagination;
}

export interface PerpClobFundingPaymentsRequest
  extends NetworkSelectionRequest {
  address: string;
  market: string;
  skip?: number; // skip last n funding payments
  limit?: number; // 1 to 100
  endTime?: number; // Upper bound of funding payment timestamp
}

export interface PerpClobFundingPaymentsResponse {
  network: string;
  timestamp: number;
  latency: number;
  fundingPayments: Array<FundingPayment>;
  pagination: ExchangePagination;
}
