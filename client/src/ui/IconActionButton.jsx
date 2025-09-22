import { IconButton, Tooltip } from '@mui/material'

// Reusable icon button with consistent 20px icon size and hit-area
export default function IconActionButton({ title, color = 'default', onClick, children, size = 'small' }){
  return (
    <Tooltip title={title}>
      <IconButton size={size} color={color} onClick={onClick} sx={{ '& .MuiSvgIcon-root': { fontSize: 20 } }}>
        {children}
      </IconButton>
    </Tooltip>
  )
}


