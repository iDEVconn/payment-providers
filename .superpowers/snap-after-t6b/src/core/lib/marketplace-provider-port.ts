import type {
  ExecuteCaptureMarketplaceOrderRequest,
  ExecuteCaptureMarketplaceOrderResult,
  ExecuteCreateMarketplaceOrderRequest,
  ExecuteCreateMarketplaceOrderResult,
  ExecuteGetMarketplaceOrderRequest,
  ExecuteGetMarketplaceOrderResult,
  ExecuteGetRefundRequest,
  ExecuteGetRefundResult,
  ExecuteRefundMarketplaceUnitRequest,
  ExecuteRefundMarketplaceUnitResult,
} from '../../contracts/index';

export type MarketplaceProviderPort = {
  createOrder(
    input: ExecuteCreateMarketplaceOrderRequest,
  ): Promise<ExecuteCreateMarketplaceOrderResult>;
  getOrder(input: ExecuteGetMarketplaceOrderRequest): Promise<ExecuteGetMarketplaceOrderResult>;
  captureOrder(
    input: ExecuteCaptureMarketplaceOrderRequest,
  ): Promise<ExecuteCaptureMarketplaceOrderResult>;
  refundUnit(
    input: ExecuteRefundMarketplaceUnitRequest,
  ): Promise<ExecuteRefundMarketplaceUnitResult>;
  getRefund(input: ExecuteGetRefundRequest): Promise<ExecuteGetRefundResult>;
};
