import { useEffect } from 'react'
import SideBarPanel from './sidebar-panel'
import SidePanel from './side-panel'
import GroupedSidebarMenu from './menu-preview'
import TransferList from './transfer-list'
import SideIcon from './side-icon'
import { AimOutlined, UpCircleOutlined } from '../icons/ui-icons'
import { Tooltip } from 'antd'
import hasActiveInput from '../../common/has-active-input'
import './sidebar.styl'

export default function Sidebar (props) {
  const {
    height,
    upgradeInfo,
    zoom,
    fileTransfers,
    transferHistory,
    transferTab,
    // expandable bookmarks/history panel
    leftSidePanelWidth,
    // responsive navigation column (0 when hidden)
    leftSideBarWidth,
    pinned,
    openedSideBar,
    showModal,
    sidebarPanelTab,
    isMobile
  } = props

  const { store } = window
  const e = window.translate
  const {
    checkingRemoteVersion,
    showUpgradeModal,
    shouldUpgrade,
    upgradePercent
  } = upgradeInfo

  // pinned is desktop-only, like the right panel's: on mobile the panel spans
  // the viewport and there is no pin control to unpin it, so a pin persisted
  // from a desktop session must not turn into a mode the user cannot leave.
  const pinnedActive = pinned && !isMobile

  const handleClickOutside = (event) => {
    const { store } = window
    // Nothing to dismiss when the panel is closed or pinned; also ignore
    // clicks while typing in an input so the panel is not yanked away
    // mid-interaction. Read the pin live rather than from the render scope:
    // this listener is attached once, so a captured value would go stale.
    if (!store.openedSideBar || (store.pinned && !store.isMobile) || hasActiveInput()) {
      return
    }
    const target = event.target
    // Never treat the panel itself or the bookmark toggle button as "outside".
    // The very click that toggles the panel open lands on that button, so this
    // guard makes the toggle immune to event-ordering races — and, in dev hot
    // reloads, to stale listeners left behind by an older build.
    if (target.closest && (
      target.closest('.sidebar-panel') ||
      target.closest('.bookmark-sidebar-toggle')
    )) {
      return
    }
    store.setOpenedSideBar('')
  }

  // One always-on document listener for click-outside dismissal, attached
  // once. Previously the listener was added/removed from inside the bookmark
  // click handler, so it leaked when the panel was closed via the ✕ icon and
  // then instantly re-closed the panel on the next bookmark-icon click.
  useEffect(() => {
    document.addEventListener('click', handleClickOutside)
    return () => {
      document.removeEventListener('click', handleClickOutside)
    }
  }, [])

  const handleClickBookmark = () => {
    if (showModal) {
      store.showModal = 0
    }
    store.openLeftSidePanel()
  }

  const {
    setLeftSidePanelWidth
  } = store
  const sideProps = openedSideBar
    ? {
        className: 'sidebar-list',
        style: {
          width: `${leftSidePanelWidth}px`
        }
      }
    : {
        className: 'sidebar-list'
      }
  const sidebarProps = {
    className: `sidebar sidebar-menu-preview type-${openedSideBar}${leftSideBarWidth === 0 ? ' collapsed' : ''}${leftSideBarWidth > 43 ? ' sidebar-expanded' : ' preview-compact'}`,
    style: {
      width: leftSideBarWidth,
      height
    }
  }
  return (
    <div {...sidebarProps}>
      <GroupedSidebarMenu
        handleClickBookmark={handleClickBookmark}
      >
        <TransferList
          fileTransfers={fileTransfers}
          transferHistory={transferHistory}
          transferTab={transferTab}
        />
        {Math.round((zoom ?? 1) * 100) !== 100 && (
          <SideIcon title={e('resetzoom')} onClick={() => store.onZoomReset()}>
            <AimOutlined className='iblock font16 control-icon zoom-reset-icon' />
          </SideIcon>
        )}
        {!checkingRemoteVersion && !showUpgradeModal && shouldUpgrade && (
          <Tooltip title={`${e('upgrading')} ${upgradePercent || 0}%`} placement='right'>
            <SideIcon
              title={e('checkForUpdate')}
              onClick={() => { store.upgradeInfo.showUpgradeModal = true }}
            >
              <UpCircleOutlined className='iblock font18 control-icon upgrade-icon' />
            </SideIcon>
          </Tooltip>
        )}
      </GroupedSidebarMenu>
      <SidePanel
        sideProps={sideProps}
        setLeftSidePanelWidth={setLeftSidePanelWidth}
        leftSidePanelWidth={leftSidePanelWidth}
        leftSideBarWidth={leftSideBarWidth}
        isMobile={isMobile}
      >
        <SideBarPanel
          pinned={pinnedActive}
          sidebarPanelTab={sidebarPanelTab}
          isMobile={isMobile}
        />
      </SidePanel>
    </div>
  )
}
