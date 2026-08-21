import { BoltRounded, SpeedRounded } from '@mui/icons-material'
import {
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  Drawer,
  Stack,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  getNodeRouteLabel,
  getRegionFlag,
  getRegionName,
  type NodeCatalog,
} from '@/hooks/use-node-catalog'
import { designTokens, modeTokens } from '@/pages/_theme'

interface RegionSheetProps {
  open: boolean
  onClose: () => void
  catalog: NodeCatalog
}

const SheetRow = ({
  children,
  onClick,
  disabled = false,
  ariaLabel,
  selected = false,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  ariaLabel?: string
  selected?: boolean
}) => {
  const theme = useTheme()
  const tokens = modeTokens(theme.palette.mode)

  return (
    <ButtonBase
      component="button"
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={selected}
      sx={{
        width: '100%',
        minHeight: 54,
        px: 2,
        py: 1.25,
        display: 'flex',
        justifyContent: 'flex-start',
        textAlign: 'left',
        borderTop: `1px solid ${tokens.outline}`,
        color: 'text.primary',
        bgcolor: selected
          ? alpha(theme.palette.primary.main, 0.1)
          : 'transparent',
        transition: theme.transitions.create('background-color'),
        '&:hover': {
          bgcolor: selected
            ? alpha(theme.palette.primary.main, 0.1)
            : alpha(theme.palette.primary.main, 0.06),
        },
        '&:focus-visible': {
          outline: `2px solid ${alpha(theme.palette.primary.main, 0.6)}`,
          outlineOffset: -2,
        },
        '&.Mui-disabled': {
          color: 'text.primary',
          opacity: 1,
        },
      }}
    >
      {children}
    </ButtonBase>
  )
}

export const RegionSheet = ({ open, onClose, catalog }: RegionSheetProps) => {
  const theme = useTheme()
  const { t } = useTranslation()
  const {
    groupName,
    nodes,
    regions,
    selectedKey,
    recommendedNode,
    recommendedDelay,
    testingDelay,
    getNodeDelay,
    getDelayLabel,
    getDelayColor,
    selectNode,
    testDelay,
  } = catalog

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            maxHeight: 'min(78vh, 620px)',
            borderRadius: '28px 28px 0 0',
            bgcolor: '#fff',
            backgroundImage: 'none',
            color: theme.palette.text.primary,
            overflow: 'hidden',
          },
        },
      }}
    >
      <Box sx={{ px: 2, pt: 1.25, pb: 1 }}>
        <Box
          aria-hidden="true"
          sx={{
            width: 42,
            height: 4,
            mx: 'auto',
            mb: 1.5,
            borderRadius: designTokens.radius.pill,
            bgcolor: alpha(theme.palette.text.primary, 0.16),
          }}
        />
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
        >
          <Typography fontSize={20} fontWeight={900}>
            {t('layout.components.connect.region.title')}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            startIcon={
              testingDelay ? (
                <CircularProgress size={15} />
              ) : (
                <SpeedRounded sx={{ fontSize: 17 }} />
              )
            }
            onClick={() => void testDelay()}
            disabled={!groupName || nodes.length === 0 || testingDelay}
            sx={{
              minHeight: 32,
              px: 1.5,
              borderColor: alpha(theme.palette.primary.main, 0.32),
              bgcolor: alpha(theme.palette.primary.main, 0.05),
              fontWeight: 850,
            }}
          >
            {testingDelay
              ? t('layout.components.nodes.actions.testing')
              : t('layout.components.connect.region.test')}
          </Button>
        </Stack>
      </Box>

      <Box sx={{ overflowY: 'auto', pb: 2 }}>
        {recommendedNode && recommendedDelay > 0 && (
          <SheetRow
            onClick={() => {
              selectNode(recommendedNode)
              onClose()
            }}
            disabled={recommendedNode.key === selectedKey}
            selected={recommendedNode.key === selectedKey}
            ariaLabel={recommendedNode.displayName}
          >
            <Box
              sx={{
                width: 34,
                height: 34,
                mr: 1.25,
                display: 'grid',
                placeItems: 'center',
                borderRadius: designTokens.radius.md,
                color: 'primary.main',
                bgcolor: alpha(theme.palette.primary.main, 0.1),
                flex: '0 0 auto',
              }}
            >
              <BoltRounded fontSize="small" />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography fontSize={14} fontWeight={900} color="primary.main">
                {t('layout.components.connect.region.smartTitle')}
              </Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {t('layout.components.connect.region.smartSummary', {
                  city: getRegionName(recommendedNode.displayName),
                  latency: recommendedDelay,
                })}
              </Typography>
            </Box>
          </SheetRow>
        )}

        {regions.map((region) => (
          <Box key={region.name}>
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ px: 2, pt: 1.5, pb: 0.75 }}
            >
              <Typography component="span" sx={{ fontSize: 19, lineHeight: 1 }}>
                {getRegionFlag(region.name)}
              </Typography>
              <Typography fontSize={13} fontWeight={850} color="text.secondary">
                {region.name}
              </Typography>
            </Stack>
            {region.nodes.map((node) => {
              const selected = node.key === selectedKey
              const delay = getNodeDelay(node)
              return (
                <SheetRow
                  key={`${node.key}:${node.name}`}
                  onClick={() => {
                    selectNode(node)
                    onClose()
                  }}
                  disabled={selected}
                  selected={selected}
                  ariaLabel={node.displayName}
                >
                  <Box sx={{ minWidth: 0, flex: 1, pl: 1.25 }}>
                    <Typography fontSize={15} fontWeight={800} noWrap>
                      {getNodeRouteLabel(node.displayName)}
                    </Typography>
                  </Box>
                  <Stack
                    direction="row"
                    spacing={0.75}
                    alignItems="center"
                    sx={{ flex: '0 0 auto' }}
                  >
                    <Box
                      aria-hidden="true"
                      sx={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        bgcolor: getDelayColor(delay),
                      }}
                    />
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {getDelayLabel(delay)}
                    </Typography>
                  </Stack>
                </SheetRow>
              )
            })}
          </Box>
        ))}

        {nodes.length === 0 && (
          <Typography
            color="text.secondary"
            sx={{ px: 2, py: 4, textAlign: 'center' }}
          >
            {t('layout.components.nodes.empty.title')}
          </Typography>
        )}
      </Box>
    </Drawer>
  )
}
