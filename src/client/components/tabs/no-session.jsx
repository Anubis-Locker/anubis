import { Button } from 'antd'
import {
  RobotOutlined,
  CodeFilled,
  PlusCircleOutlined,
  ThunderboltOutlined,
  HistoryOutlined
} from '../icons/ui-icons'
import { packInfo } from '../../common/constants'
import HistoryPanel from '../sidebar/history'
import QuickConnect from './quick-connect'
import { isAIDisabled } from '../../common/ai-feature'
import './no-session.styl'

const e = window.translate

export default function NoSessionPanel ({ height, onNewTab, onNewSsh, batch }) {
  const props = {
    style: {
      maxHeight: height + 'px'
    }
  }
  const handleClick = () => {
    window.openTabBatch = batch
  }

  const handleCreateAIBookmark = () => {
    window.store.onNewSshAI()
  }

  const newTabDom = window.store.hasNodePty
    ? (
      <Button
        onClick={onNewTab}
        className='add-new-tab-btn'
        icon={<CodeFilled />}
      >
        {e('newTab')}
      </Button>
      )
    : null
  return (
    <div className='no-sessions' {...props}>
      <header className='workspace-heading'>
        <h1>{e('sessions')}</h1>
        <span className='workspace-version'>v{packInfo.version}</span>
      </header>
      <div className='workspace-grid'>
        <section className='workspace-card workspace-welcome'>
          <div className='workspace-card-heading'>
            <span className='workspace-eyebrow'>{window.et.brand.name}</span>
            <h2>{e('newBookmark')}</h2>
            <p className='workspace-protocols'>SSH · SFTP · RDP · VNC · Telnet · Serial · FTP · Spice</p>
          </div>
          <div className='no-session-btns'>
            {newTabDom}
            <Button
              onClick={onNewSsh}
              icon={<PlusCircleOutlined />}
            >
              {e('newBookmark')}
            </Button>
            {!isAIDisabled() && (
              <Button
                onClick={handleCreateAIBookmark}
                icon={<RobotOutlined />}
              >
                {e('createBookmarkByAI')}
              </Button>
            )}
          </div>
        </section>
        <section className='workspace-card workspace-connect'>
          <h2><ThunderboltOutlined /> {e('quickConnect')}</h2>
          <QuickConnect batch={batch} inputOnly />
        </section>
        <section className='workspace-card no-session-history' onClick={handleClick}>
          <h2><HistoryOutlined /> {e('history')}</h2>
          <HistoryPanel sort />
        </section>
      </div>
    </div>
  )
}
