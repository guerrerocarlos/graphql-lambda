// import * as WebSocket from 'ws';
import { ExtendableError } from "./errors";
import {
  IConnection,
  IConnectEvent,
  IConnectionManager,
  IConnectionData,
} from "./types";
import { ApiGatewayManagementApi } from "aws-sdk";

class ConnectionNotFoundError extends ExtendableError {}

type ApiGatewayConnectionManagerParams = {
  connectionManagerStorage?: Map<string, IConnection>;
};

export class ApiGatewayConnectionManager implements IConnectionManager {
  private apiGatewayManager: ApiGatewayManagementApi | undefined;
  public connections: Map<string, IConnection>;

  constructor({ connectionManagerStorage }: ApiGatewayConnectionManagerParams) {
    this.connections = connectionManagerStorage || new Map();
  }

  hydrateOrRegisterConnection = async (
    connectionId: string,
    endpoint: string
  ) => {
    console.log("hydrateOrRegisterConnection", connectionId);

    let connection: IConnection | undefined = this.connections.get(connectionId);

    if (connection == null) {
      connection = {
        id: connectionId,
        data: { endpoint, context: {}, isInitialized: true },
      };

      this.connections.set(connectionId, connection);
    }

    return connection;
  };

  hydrateConnection = async (connectionId: string): Promise<IConnection> => {
    // if connection is not found, throw so we can terminate connection
    console.log("hydrateConnection", connectionId);

    const connection = this.connections.get(connectionId);

    if (connection == null) {
      throw new ConnectionNotFoundError(`Connection ${connectionId} not found`);
    }

    return connection;
  };

  setConnectionData = async (
    data: IConnectionData,
    connection: IConnection
  ): Promise<void> => {
    console.log("sendToConnection", connection, data);

    this.connections.set(connection.id, {
      id: connection.id,
      data,
    });
  };

  registerConnection = async ({
    connectionId,
    endpoint,
  }: IConnectEvent): Promise<IConnection> => {
    console.log("registerConnection", connectionId);
    const connection: IConnection = {
      id: connectionId,
      data: { endpoint, context: {}, isInitialized: false },
    };

    this.connections.set(connectionId, connection);

    return connection;
  };

  sendToConnection = async (
    connection: IConnection,
    payload: string | Buffer
  ): Promise<void> => {
    console.log("sendToConnection", { connection, payload });
    try {
      await this.createApiGatewayManager(connection.data.endpoint)
        .postToConnection({ ConnectionId: connection.id, Data: payload })
        .promise();
    } catch (e) {
      console.log("failed to send", e);
      // this is stale connection
      // remove it from DB
      if (e && e.statusCode === 410) {
        await this.unregisterConnection(connection);
      } else {
        throw e;
      }
    }
  };

  unregisterConnection = async (connection: IConnection): Promise<void> => {
    console.log("unregisterConnection", connection);
    this.connections.delete(connection.id);
  };

  closeConnection = async (connection: IConnection): Promise<void> => {
    console.log("closeConnection", connection);

    setTimeout(() => {
      // wait so we can send error message first
      console.log("CLOSE CONNECTION:", connection);
    }, 10);
  };

  /**
   * Creates api gateway manager
   *
   * If custom api gateway manager is provided, uses it instead
   */
  private createApiGatewayManager(endpoint: string): ApiGatewayManagementApi {
    if (this.apiGatewayManager) {
      return this.apiGatewayManager;
    }

    this.apiGatewayManager = new ApiGatewayManagementApi({
      endpoint,
      apiVersion: "2018-11-29",
    });

    return this.apiGatewayManager;
  }
}
