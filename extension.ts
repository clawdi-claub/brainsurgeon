import { Type } from '@sinclair/typebox';

export default function (api) {
  // Register restore_response tool
  api.registerTool({
    name: 'restore_response',
    description: 'Rehydrate pruned tool response content from external storage',
    parameters: Type.Object({
      toolcallid: Type.String({ description: 'ID of tool call to restore' }),
    }),
    async execute(_id, params) {
      const { toolcallid } = params;
      
      // This will be implemented when the extension connects to the TypeScript API
      return {
        content: [
          {
            type: 'text',
            text: `Tool response rehydrated for tool call: ${toolcallid}`,
          },
        ],
      };
    },
  });

  // Subscribe to OpenClaw events
  api.subscribeEvent('message_written', async (event) => {
    // Forward message_written events to TypeScript API
    console.log('message_written event received:', event);
  });

  api.subscribeEvent('session_created', async (event) => {
    // Forward session_created events to TypeScript API
    console.log('session_created event received:', event);
  });

  // Extension lifecycle
  api.onActivate = async () => {
    console.log('BrainSurgeon extension activated');
    // Connect to message bus, start event listeners
  };

  api.onDeactivate = async () => {
    console.log('BrainSurgeon extension deactivated');
    // Disconnect, cleanup resources
  };
}
