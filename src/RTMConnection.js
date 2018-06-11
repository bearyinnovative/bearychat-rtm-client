import { EventEmitter }  from 'events';
import RTMConnectionState from './RTMConnectionState';
import RTMConnectionEvents from './RTMConnectionEvents';
import RTMMessageTypes from './RTMMessageTypes';
import delay from './delay';
import invariant from 'invariant';

export class RTMPingTimeoutError extends Error {
  constructor(errorMessage) {
    super(errorMessage);
    this.constructor = RTMPingTimeoutError;
    this.__proto__ = RTMPingTimeoutError.prototype;
  }
}

/**
 * Keep a WebSocket connection with server, handling heartbeat events,
 * omitting obsolete message types.
 *
 * State diagram:
 *
 *    INITIAL
 *       +
 *       |
 *       |
 *       v
 *   CONNECTED +-+
 *       +       |
 * client|       |
 * close |       | server
 *       v       | close/
 *    CLOSING    | error
 *       +       |
 *       |       |
 *       |       |
 *       v       |
 *    CLOSED <---+
 */
export default class RTMConnection extends EventEmitter {

  state = {};

  constructor({ url, WebSocket, pingInterval, pingTimeout }) {
    super();
    this._pingTimeout = pingTimeout;
    this._pingInterval = pingInterval;
    this._currentCallId = 0;
    this._state = RTMConnectionState.INITIAL;
    this._ws = new WebSocket(url);
    this._callbackMap = new Map();
    this._pingMap = new Map();

    this._ws.addEventListener('open', this._handleOpen);
    this._ws.addEventListener('close', this._handleClose);
    this._ws.addEventListener('message', this._handleMessage);
    this._ws.addEventListener('error', this._handleError);
  }

  _handleOpen = () => {
    this._state = RTMConnectionState.CONNECTED;
    this.emit(RTMConnectionEvents.OPEN);
    this._startLoop();
  };

  _handleClose = () => {
    this._state = RTMConnectionState.CLOSED;
    this.emit(RTMConnectionEvents.CLOSE);
  };

  _handleMessage = (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case RTMMessageTypes.PONG:
        this._handlePongMessage(message);
        break;
      case RTMMessageTypes.OK:
        // ignore deprecated events
        break;
      case RTMMessageTypes.REPLY:
        this._handleReplyMessage(message);
        break;
      default:
        this.emit(RTMConnectionEvents.MESSAGE, message);
    }
  };

  _handlePongMessage(message) {
    const callId = message.call_id;
    const pingMap = this._pingMap;

    const cancel = pingMap.get(callId);
    pingMap.delete(callId);
    cancel && cancel(message);
  }

  _handleReplyMessage(message) {
    const callbackMap = this._callbackMap;
    const callId = message.call_id;

    if (process.env.NODE_ENV !== 'production') {
      invariant(
        callbackMap.has(callId),
        'Call id replied without sending: %s',
        callId
      );
    }

    const callback = callbackMap.get(callId);
    callbackMap.delete(callId);
    callback && callback(message);
  }

  _handleError = (error) => {
    this.emit(RTMConnectionEvents.ERROR, error);
  };

  _getNextCallId() {
    return this._currentCallId++;
  }

  send(message) {
    if (!message.call_id) {
      message = {
        ...message,
        call_id: this._getNextCallId()
      };
    }

    const callIdMap = this._callbackMap;
    const callId = message.call_id;

    invariant(
      !callIdMap.has(callId),
      'Duplicate call id %s',
      callId
    );

    return new Promise((resolve) => {
      callIdMap.set(callId, resolve);
      this._ws.send(JSON.stringify(message));
    });
  }

  _ping() {
    const callId = this._getNextCallId();

    const pingTimeoutError = new RTMPingTimeoutError('Ping timeouted.');
    const pingKeeper = delay.reject(this._pingTimeout, pingTimeoutError);
    this._pingMap.set(callId, pingKeeper.cancel);
    pingKeeper.catch(error => {
      if (error instanceof RTMPingTimeoutError) {
        this.emit(RTMConnectionEvents.ERROR, error);
        this.close();
      }
    });

    this.send({
      call_id: callId,
      type: RTMMessageTypes.PING
    });
  }

  _startLoop = async () => {
    while (this._state === RTMConnectionState.CONNECTED) {
      this._ping();
      await delay(this._pingInterval);
    }
  };

  close() {
    this._state = RTMConnectionState.CLOSING;
    this._ws.close();
  }
}
