/**
 * editor (embedded in the common settings page) for the customizable
 * grouped sidebar icons. Selection order applies within each fixed group.
 */

import { Select } from 'antd'
import {
  groupedSidebarIconOptions,
  groupedSidebarIconIds
} from '../../common/left-sidebar-icon-defs'

const { Option } = Select
const e = window.translate

export default function SettingLeftSidebarIcons (props) {
  const { config, store } = props
  const value = groupedSidebarIconIds(config.leftSideBarIcons)

  const handleChange = (v) => {
    store.updateConfig({
      leftSideBarIcons: [
        ...v,
        ...(Array.isArray(config.leftSideBarIcons)
          ? config.leftSideBarIcons.filter(id => !groupedSidebarIconOptions.some(opt => opt.id === id))
          : [])
      ]
    })
  }

  return (
    <div className='pd2b'>
      <div className='pd1b'>{e('leftSideBarIcons')}</div>
      <Select
        mode='multiple'
        value={value}
        onChange={handleChange}
        popupMatchSelectWidth={false}
        style={{ minWidth: 320, width: '100%' }}
        placeholder={e('leftSideBarIcons')}
      >
        {
          groupedSidebarIconOptions.map(opt => {
            return (
              <Option
                key={opt.id}
                value={opt.id}
              >
                {e(opt.text)}
              </Option>
            )
          })
        }
      </Select>
      <p className='pd1t'>
        Visibility and selection order apply within Tools and Other. Group order,
        AI Agents, PRO Features, About and Hide are fixed. New bookmark and
        Terminal themes remain available in the application menu and settings;
        their older sidebar selections are preserved but do not add menu items.
      </p>
    </div>
  )
}
