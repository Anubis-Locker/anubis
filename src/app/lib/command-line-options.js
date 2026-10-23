/**
 * command line support
 */

function createCommandLine ({ version, cli }) {
  const { Command } = require('commander')
  const prog = new Command()

  prog
    .version(version)
    .name(cli)
    .usage('[options] sshServer')
    .description(`
### Connect ssh server from command line examples:
- ${cli} user@xx.com
- ${cli} user@xx.com:22
- ${cli} --password password --set-env "SECRET=xxx USER=hhhh" user@xx.com:22
- ${cli} -l user -P 22 -i /path/to/private-key -pw password xx.com -T -t "XX Server"

### Other params examples:
- server port:
${cli} -sp 30976
- load and run batch operation from json file:
${cli} -bo "/home/root/works.json"
- open a .vv connection file (virt-viewer / Proxmox SPICE), connecting at once:
${cli} /path/to/console.vv

### other connection types
- telnet:
${cli} -tp "telnet" -opts '{"host":"192.168.1.1","port":21","username":"root","password":"123456"}'
- rdp: ${cli} -tp "rdp" -opts '{"host":"192.168.1.1","port":3389","username":"root","password":"123456"}'
- vnc: ${cli} -tp "vnc" -opts '{"host":"192.168.1.1","port":3389","username":"root","password":"123456"}'
- serial: ${cli} -tp "serial" -opts '{"port":"COM1","baudRate":115200,"dataBits":8,"stopBits":1,"parity":"none"}'
- local: ${cli} -tp "local" -opts '{"title": "local terminal"}'

### Environment variables:
- DATA_PATH:
DATA_PATH=/custom/path/to/${cli}-data ${cli}

- NO_PROXY_SERVER:
NO_PROXY_SERVER=1 ${cli}

- PROXY_BYPASS_LIST:
PROXY_BYPASS_LIST="127.0.0.1, 127.0.0.1" ${cli}

- PROXY_PAC_URL:
PROXY_PAC_URL="http://proxy.example.com/pac" ${cli}

- PROXY_SERVER:
PROXY_SERVER="socks5://127.0.0.1:1080" ${cli}
`)
    .option('-t, --title [Tab Name]', 'Specify the title of the new tab')
    .option('-l, --user <user>', 'specify a login name')
    .option('-P, --port <port>', 'specify ssh port')
    .option('-bo, --batch-op <batchOpFile>', 'load and run batch operation from json file')
    .option('-sp, --server-port <serverPort>', 'specify server port, default is')
    .option('-i, --private-key-path <path>', 'specify an SSH private key path')
    .option('-ps, --passphrase <passphrase>', 'specify an SSH private key passphrase')
    .option('-pw, --password <password>', 'specify ssh server password')
    .option('-se, --set-env <setEnv>', 'specify envs')
    .option('-so, --sftp-only', 'only show sftp panel')
    .option('-d, --init-folder <initFolder>', 'init folder got init terminal')
    .option('-tp, --tp <tp>', 'specify connection type')
    .option('-opts, --opts <opts>', 'specify connection options, json string')
    .allowUnknownOption()
    .exitOverride()

  return prog
}

module.exports = { createCommandLine }
