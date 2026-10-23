import { useState } from 'react'
import { auto } from 'manate/react'
import { Modal, Popover, Tooltip } from 'antd'
import {
  Wrench, ShieldCheck, Ellipsis, ChevronDown,
  BookOpen, Zap, CloudCog, Bot, LayoutGrid,
  Users, Package, Workflow, FileSearch, ShieldAlert, Coins, Globe,
  Settings, Info, PanelLeftClose
} from 'lucide-react'
import MenuBtn from '../sys-menu/menu-btn'
import ExternalLink from '../common/external-link'
import QuickConnect from '../tabs/quick-connect'
import { brand, modals, settingMap } from '../../common/constants'
import { isAIDisabled } from '../../common/ai-feature'
import { groupedSidebarIconIds } from '../../common/left-sidebar-icon-defs'
import './menu-preview.styl'

const groups = [
  {
    label: 'Tools',
    icon: Wrench,
    items: [
      { id: 'bookmarks', label: 'Bookmarks', icon: BookOpen },
      { id: 'quickConnect', label: 'Quick connect', icon: Zap },
      { id: 'settingSync', label: 'Setting sync', icon: CloudCog },
      { label: 'AI Agents', icon: Bot },
      { id: 'widgets', label: 'Widgets', icon: LayoutGrid }
    ]
  },
  {
    label: 'PRO Features',
    icon: ShieldCheck,
    pro: true,
    items: [
      { label: 'Community', icon: Users },
      { label: 'Plugin Store', icon: Package },
      { label: 'Automation', icon: Workflow },
      { label: 'DLL Scanner', icon: FileSearch },
      { label: 'CVE Scanner', icon: ShieldAlert },
      { label: 'Crypto Miner', icon: Coins },
      { label: 'Browser Control', icon: Globe }
    ]
  },
  {
    label: 'Other',
    icon: Ellipsis,
    items: [
      { id: 'setting', label: 'Setting', icon: Settings },
      { label: 'About', icon: Info },
      { label: 'Hide', icon: PanelLeftClose }
    ]
  }
]

export default auto(function GroupedSidebarMenu ({ handleClickBookmark, children }) {
  const [preview, setPreview] = useState(null)
  const { store } = window
  const iconIds = groupedSidebarIconIds(store.config.leftSideBarIcons)
  const configuredGroups = groups.map(group => {
    const ordered = group.items
      .filter(item => item.id && iconIds.includes(item.id))
      .sort((a, b) => iconIds.indexOf(a.id) - iconIds.indexOf(b.id))
    return {
      ...group,
      items: group.items.flatMap(item => item.id ? (ordered.shift() || []) : item)
    }
  })
  const settingVisible = store.showModal === modals.setting
  const activeItems = {
    Bookmarks: store.openedSideBar === 'bookmarks',
    'Setting sync': settingVisible && store.settingTab === settingMap.setting && store.settingItem.id === 'setting-sync',
    'AI Agents': store.rightPanelVisible && store.rightPanelTab === 'ai',
    Widgets: settingVisible && store.settingTab === settingMap.widgets,
    Setting: settingVisible && store.settingTab === settingMap.setting && store.settingItem.id === 'setting-common',
    About: store.showInfoModal
  }
  const actions = {
    Bookmarks: handleClickBookmark,
    'Setting sync': () => store.openSettingSync(),
    'AI Agents': () => store.toggleAIPanel(),
    Widgets: () => store.openWidgetsModal(),
    Setting: () => store.openSetting(),
    About: () => store.openAbout(),
    Hide: () => store.toggleLeftSideBar()
  }

  function selectItem (item) {
    if (item.pro) {
      setPreview(item)
    } else {
      actions[item.label]()
    }
  }

  return (
    <>
      <div className='preview-brand'>
        <MenuBtn store={store} config={store.config} />
      </div>
      <nav className='preview-navigation' aria-label='Application sections'>
        {configuredGroups.map(({ label, icon: GroupIcon, items, pro = false }) => (
          <details className='preview-group' key={label} open>
            <summary title={label}>
              <GroupIcon size={17} strokeWidth={1.75} aria-hidden='true' />
              <span className='preview-label'>{label}</span>
              <ChevronDown className='preview-chevron' size={13} aria-hidden='true' />
            </summary>
            {items.map(({ label, icon: Icon }) => {
              const active = pro ? preview?.label === label : activeItems[label]
              const button = (
                <button
                  className={`preview-menu-item${active ? ' active' : ''}${label === 'Bookmarks' ? ' bookmark-sidebar-toggle' : ''}`}
                  type='button'
                  aria-label={label}
                  aria-current={active ? 'page' : undefined}
                  disabled={label === 'AI Agents' && isAIDisabled()}
                  onClick={label === 'Quick connect' ? undefined : () => selectItem({ label, pro })}
                >
                  <Icon size={18} strokeWidth={1.75} aria-hidden='true' />
                  <span className='preview-label'>{label}</span>
                </button>
              )
              return label === 'Quick connect'
                ? (
                  <Popover key={label} content={<QuickConnect inputOnly />} trigger='click' placement='right'>
                    {button}
                  </Popover>
                  )
                : (
                  <Tooltip key={label} title={pro ? 'Available only in the PRO version' : label} placement='right'>
                    {button}
                  </Tooltip>
                  )
            })}
          </details>
        ))}
      </nav>
      <div className='preview-footer' role='group' aria-label='Application controls'>
        {children}
      </div>
      <Modal
        open={preview !== null}
        title={preview?.label}
        onCancel={() => setPreview(null)}
        footer={null}
        centered
      >
        <div className='pro-version-placeholder'>
          <p>This section is available only in the PRO version.</p>
          <p>
            Learn more on our official website:{' '}
            <ExternalLink to={brand.domains.site}>{brand.domains.site}</ExternalLink>
          </p>
        </div>
      </Modal>
    </>
  )
})
