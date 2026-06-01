#!/usr/bin/env node

// Test script to verify tool definitions
import evidenceTrackerPlugin from './index.ts';

console.log('=== Evidence Tracker Plugin Test ===\n');

// Mock API
const mockApi = {
  logger: {
    info: (msg) => console.log('[INFO]', msg),
    error: (msg) => console.error('[ERROR]', msg),
  },
  registeredTools: [],
  registerTool: function(tool) {
    this.registeredTools.push(tool);
    console.log(`\n✓ Registered tool: ${tool.name}`);
    console.log(`  Description: ${tool.description.slice(0, 80)}...`);

    // Check parameters
    if (tool.parameters && tool.parameters._def) {
      const shape = tool.parameters._def.shape();
      const paramNames = Object.keys(shape);
      console.log(`  Parameters: ${paramNames.join(', ') || '(none)'}`);

      paramNames.forEach(name => {
        const param = shape[name];
        const isOptional = param.isOptional();
        const type = param._def.typeName;
        console.log(`    - ${name}: ${type}${isOptional ? ' (optional)' : ' (required)'}`);
      });
    }
  }
};

// Register plugin
evidenceTrackerPlugin.register(mockApi);

console.log(`\n=== Summary ===`);
console.log(`Total tools registered: ${mockApi.registeredTools.length}`);
console.log(`\nTool names:`);
mockApi.registeredTools.forEach((tool, i) => {
  console.log(`  ${i + 1}. ${tool.name}`);
});
