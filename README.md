[![npm version](https://badge.fury.io/js/graphql-lambda.svg)](https://badge.fury.io/js/graphql-lambda)

This is a AWS Lambda integration of GraphQL Server with Subscriptions support.

Heavily inspired on [aws-lambda-graphql](https://github.com/michalkvasnicak/aws-lambda-graphql) module.

Also based on Apollo Server (a community-maintained open-source GraphQL server that works with many Node.js HTTP server frameworks).

```shell
npm install graphql-lambda
```

# Working Examples

## Ready-to-deploy (`serverless deploy`) examples:

-   [graphql-lambda-nexus-example](https://github.com/guerrerocarlos/graphql-lambda-nexus-example) uses [nexus](https://nexus.js.org/)
-   [graphql-lambda-sdl-example](https://github.com/guerrerocarlos/graphql-lambda-sdl-example) uses GraphQL SDL

# Deploying with AWS Serverless Framework

## GraphQL SDL Example:

### Define GraphQL Schemas

Following the same GraphQL SDL setup as in [graphql-lambda-sdl-example](https://github.com/guerrerocarlos/graphql-lambda-sdl-example), define your Schemas and subscriptions in a file called `schema.ts`

```ts
import { pubSub, withFilter } from "../lambda";

type MessageType = 'greeting' | 'test';

type Message = {
  text: string;
  type: MessageType;
};

type SendMessageArgs = {
  text: string;
  type: MessageType;
};

export const typeDefs = /* GraphQL */ `
  enum MessageType {
    greeting
    test
  }
  type Message {
    id: ID!
    text: String!
    type: MessageType!
  }
  type Mutation {
    sendMessage(text: String!, type: MessageType = greeting): Message!
  }
  type Query {
    serverTime: Float!
  }
  type Subscription {
    messageFeed(type: MessageType): Message!
  }
`;

export const resolvers = {
  Mutation: {
    async sendMessage(ctx: any, { text, type }: SendMessageArgs) {
      const payload: Message = { text, type };

      await pubSub.publish('NEW_MESSAGE', payload);

      return payload;
    },
  },
  Query: {
    serverTime: () => Date.now(),
  },
  Subscription: {
    messageFeed: {
      resolve: (rootValue: Message) => {
        // root value is the payload from sendMessage mutation
        return rootValue;
      },
      subscribe: withFilter(
        pubSub.subscribe('NEW_MESSAGE'),
        (rootValue: Message, args: { type: null | MessageType }) => {
          // this can be async too :)
          if (args.type == null) {
            return true;
          }

          return args.type === rootValue.type;
        },
      ),
    },
  },
};
```

### Initialize all components for Subscriptions to work with AWS API Gateway V2 Websockets:

In a file named `lambda.ts` place the following code:

```ts
import { APIGatewayProxyEvent } from "aws-lambda";
import {
  PubSub,
  SubscriptionManager,
  ApiGatewayConnectionManager,
  ISubscriptionEvent,
  IEventStore,
  APIGatewayWebSocketEvent,
} from "graphql-lambda";

import { SQS } from "aws-sdk";

export class SQSQueue implements IEventStore {
  public events: ISubscriptionEvent[];
  private sqs: SQS;

  constructor() {
    this.sqs = new SQS();
  }

  publish = async (event: ISubscriptionEvent | APIGatewayProxyEvent | APIGatewayWebSocketEvent): Promise<void> => {
    var params = {
      QueueUrl: process.env.sqsfifo,
      MessageGroupId: "0",
      MessageBody: JSON.stringify(event),
    };
    await this.sqs.sendMessage(params).promise();
  };
}

export const eventStore = new SQSQueue();
export const pubSub = new PubSub({ eventStore });
export const subscriptionManager = new SubscriptionManager({
  subscriptionManagerStorage: new Map(), // Replace this with any persistence layer you prefer, Redis, MySQL, etc.
});
export const connectionManager = new ApiGatewayConnectionManager({
  connectionManagerStorage: new Map(), // Replace this with any persistence layer you prefer, Redis, MySQL, etc.
});
export const eventProcessor = new EventProcessor()
export * from "graphql-lambda";
```

For production environments the `new Map()` should be replaced with a proper data storage like MySQL, Redis, DynamoDB, etc.

### Server Creation

Provide the schema (type definitions and resolvers) to the GraphQL Server, together with the `subscriptionsManager`, `connectionManager` and `eventProcessor` defined in `lambda.ts`. 

Place the following code in a file named `graphql.ts`:

```js
import {
  Server,
  subscriptionManager,
  connectionManager,
  EventProcessor,
  APIGatewayWebSocketEvent,
  eventStore,
  eventProcessor,
} from "./lambda";

import { typeDefs, resolvers } from "./graphql/schema";

const server = new Server({
  typeDefs,  // (schema-first approach)
  resolvers, // (schema-first approach)
  // schema, // (code-first approach)
  connectionManager,
  eventProcessor,
  subscriptionManager,

  onError: (err) => {
    console.log(err);
  },
  playground: {
    endpoint: `/${process.env.STAGE}/graphql`,
    subscriptionEndpoint: process.env.lambdaSubscriptionEndpoint,
  },
});

export const handleHttp = server.createHttpHandler();
export const handleWebSocket = server.createWebSocketHandler(); // Required for subscriptions websockets
export const eventHandler = server.createEventHandler(); // Required for subscription events
```

Optionally, a `schema` parameter can be provided to the server instead of `typeDefs` and `resolvers`.

### Separate subscriptions events into separate function through SQS (for memory persistence)

To keep this example simple and make it work without any kind of Database, we will make all graphql subscriptions events to be handled by a separated function, so we can just store everything in memory, and make sure only one function handles all the subscription-related events by piping all events through a AWS SQS FIFO Queue:

In a file named `handlers.ts`, place the following code:

```ts
import { handleHttp, handleWebSocket, eventHandler } from "./graphql"

export async function handleGraphql(
  event: APIGatewayEvent | APIGatewayWebSocketEvent,
  context
) {
  if (
    (event as APIGatewayWebSocketEvent).requestContext != null &&
    (event as APIGatewayWebSocketEvent).requestContext.routeKey != null
  ) {
    await eventStore.publish(event);

    let result = {
      body: "",
      headers: event.headers?.["Sec-WebSocket-Protocol"]?.includes("graphql-ws")
        ? {
            "Sec-WebSocket-Protocol": "graphql-ws",
          }
        : undefined,
      statusCode: 200,
    };

    return result;
  } else if (
    (event as APIGatewayEvent).requestContext != null &&
    (event as APIGatewayEvent).requestContext.path != null
  ) {
    return handleHttp(event as APIGatewayEvent, context);
  } else {
    throw new Error("Invalid event");
  }
}

export async function handleGraphqlSubscriptions(event: SQSEvent, context) {
  if ((event as SQSEvent).Records != null) {
    for (const record of (event as SQSEvent).Records) {
      const ev = JSON.parse(record.body);
      if (
        (ev as APIGatewayWebSocketEvent).requestContext != null &&
        (ev as APIGatewayWebSocketEvent).requestContext.routeKey != null
      ) {
        await handleWebSocket(ev as APIGatewayWebSocketEvent, context);
      } else {
        await eventHandler(ev, context);
      }
    }
  } else {
    throw new Error("Invalid event");
  }
}
```

Finally, this [serverless](https://serverless.com/) project requires some custom resources.

In a file named `serverless.ts` (replacing the usual serverless.yml file), place the following code:

```ts
import type { AWS } from "@serverless/typescript";

const serverlessConfiguration: AWS = {
  service: "graphql-lambda-example",
  plugins: ["serverless-webpack"],
  provider: {
    apiGateway: {
      shouldStartNameWithService: true,
    },
    name: "aws",
    runtime: "nodejs12.x",
    region: "us-east-1",
    memorySize: 512,
    iam: {
      role: {
        statements: [
          {
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: ["sqs:*"],
            Resource: "*",
          },
        ],
      },
    },
    environment: {
      STAGE: "${opt:stage, self:provider.stage}",
      sqsfifo: {
        "Fn::Join": [
          "",
          [
            "https://sqs.",
            { Ref: "AWS::Region" },
            ".amazonaws.com/",
            { Ref: "AWS::AccountId" },
            "/${self:custom.eventSQSFifo}",
          ],
        ],
      },
      lambdaSubscriptionEndpoint: {
        "Fn::Join": [
          "",
          [
            "wss://",
            {
              Ref: "WebsocketsApi",
            },
            ".execute-api.",
            {
              Ref: "AWS::Region",
            },
            ".",
            {
              Ref: "AWS::URLSuffix",
            },
            "/${self:provider.stage}",
          ],
        ],
      },
    },
  },
  functions: {
    main: {
      handler: "src/handlers.handleGraphql",
      events: [
        {
          http: {
            path: "/graphql",
            method: "ANY",
          },
        },
        {
          websocket: {
            route: "$connect",
          },
        },
        {
          websocket: {
            route: "$default",
          },
        },
        {
          websocket: {
            route: "$disconnect",
          },
        },
      ],
    },
    queue: {
      handler: "src/handlers.handleGraphqlSubscriptions",
      events: [
        {
          sqs: {
            arn: {
              "Fn::GetAtt": ["sqsfifo", "Arn"],
            },
          },
        },
      ],
    },
  },
  custom: {
    stage: "${opt:stage, self:provider.stage}",
    region: "${opt:region, self:provider.region}",
    eventSQSFifo: "${self:service}-sqs-fifo-${self:custom.stage}.fifo",
    webpack: {
      webpackConfig: "./webpack.config.js",
      includeModules: true,
    },
  },
  resources: {
    Resources: {
      sqsfifo: {
        Properties: {
          QueueName: "${self:custom.eventSQSFifo}",
          FifoQueue: true,
          ContentBasedDeduplication: true,
        },
        Type: "AWS::SQS::Queue",
      },
    },
  },
};

module.exports = serverlessConfiguration;
```

### Deploy!

Deploy to AWS Lambda and start testing!

```sh
serverless deploy
```

### Example Playground Screenshots

Query:

![Screenshot 2021-03-20 at 4 06 47 PM](https://user-images.githubusercontent.com/82532/111876407-87b7c700-8996-11eb-9f60-3469f4559d21.jpg)

Subscription:

![Screenshot 2021-03-20 at 4 06 31 PM](https://user-images.githubusercontent.com/82532/111876419-93a38900-8996-11eb-8282-74a5860030fa.jpg)

Mutation:

![Screenshot 2021-03-20 at 4 06 19 PM](https://user-images.githubusercontent.com/82532/111876437-a3bb6880-8996-11eb-98b4-7f30bac0bce7.jpg)
