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
      
      try {
        // 1. Check if external/{toolcallid}.json exists
        const externalPath = `/external/${toolcallid}.json`;
        const externalContent = await api.readFile(externalPath);
        if (!externalContent) {
          throw new Error(`No external content found for tool call: ${toolcallid}`);
        }

        // 2. Parse external content
        const externalEntry = JSON.parse(externalContent);
        
        // 3. Acquire session file lock
        const agentId = externalEntry.agentId;
        const sessionId = externalEntry.sessionId;
        const sessionFile = `/sessions/${agentId}/${sessionId}.jsonl`;
        
        // Wait for lock (blocking call)
        await api.acquireLock(sessionFile);
        
        try {
          // 4. Read current session entries
          const sessionContent = await api.readFile(sessionFile);
          const entries = sessionContent ? JSON.parse(sessionContent) : [];
          
          // 5. Find the restore_response entry and insert the tool_result
          const updatedEntries = entries.map(entry => {
            if (entry.type === 'restore_response' && entry.parameters?.toolcallid === toolcallid) {
              // Replace with the original tool_result entry
              return externalEntry;
            }
            return entry;
          });
          
          // 6. Write updated session back
          await api.writeFile(sessionFile, JSON.stringify(updatedEntries, null, 2));
          
          // 7. Delete external file (cleanup)
          await api.deleteFile(`/external/${toolcallid}.json`);
          
          // 8. Return success
          return {
            content: [
              {
                type: 'text',
                text: `Tool response rehydrated successfully for tool call: ${toolcallid}`,
              },
            ],
          };
        } finally {
          // 9. Release lock
          await api.releaseLock(sessionFile);
        }
      } catch (error) {
        console.error('restore_response tool error:', error);
        throw new Error(`Failed to restore response: ${error.message}`);
      }
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
