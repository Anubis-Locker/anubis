const { after } = require('node:test')
const policy = require('../../app/common/admin-policy')

const TEST_MCP_TOKEN = '1'.repeat(64)
const original = policy.getMcpToken
policy.getMcpToken = () => TEST_MCP_TOKEN
after(() => { policy.getMcpToken = original })

module.exports = { TEST_MCP_TOKEN }
