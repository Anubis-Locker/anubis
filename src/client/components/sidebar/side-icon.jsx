import classNames from 'classnames'

export default function SideIcon (props) {
  const {
    show,
    className,
    title = '',
    active,
    onClick,
    children
  } = props
  if (show === false) {
    return null
  }
  const cls = classNames(className, 'control-icon-wrap', {
    active
  })
  return (
    <button
      type='button'
      className={cls}
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : !!active}
      onClick={onClick}
    >
      {children}
      <span className='sidebar-nav-label'>{title}</span>
    </button>
  )
}
