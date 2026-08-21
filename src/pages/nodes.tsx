import {
  BoltRounded,
  CheckCircleRounded,
  SearchRounded,
  SpeedRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import {
  getRegionFlag,
  getNodeRouteLabel,
  groupNodes,
  useNodeCatalog,
} from '@/hooks/use-node-catalog'
import { useVerge } from '@/hooks/use-verge'
import { designTokens, modeTokens } from '@/pages/_theme'
import { useAppData } from '@/providers/app-data-context'
import { reportSafeClientFailure } from '@/services/safe-client-error'

const NodesPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = modeTokens(theme.palette.mode)
  const [searchQuery, setSearchQuery] = useState('')
  const { verge } = useVerge()
  const { refreshProxy } = useAppData()
  const connected = Boolean(
    verge?.enable_tun_mode || verge?.enable_system_proxy,
  )
  const catalog = useNodeCatalog({
    selectionScope: 'nodes-proxy-selection',
    onSelectionSuccess: refreshProxy,
    onSelectionError: (error) =>
      reportSafeClientFailure('nodes-proxy-selection', error),
  })
  const nodes = catalog.nodes
  const selectedKey = catalog.selectedKey
  const testingDelay = catalog.testingDelay
  const groupName = catalog.groupName
  const getNodeDelay = catalog.getNodeDelay
  const getDelayLabel = catalog.getDelayLabel
  const getDelayColor = catalog.getDelayColor

  const filteredNodes = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return nodes

    return nodes.filter((node) =>
      node.displayName.toLocaleLowerCase().includes(query),
    )
  }, [nodes, searchQuery])

  const regions = useMemo(() => groupNodes(filteredNodes), [filteredNodes])
  const recommendedNode = catalog.recommendedNode
  const recommendedDelay = catalog.recommendedDelay

  return (
    <BasePage
      title={t('layout.components.nodes.title')}
      header={
        <Button
          size="small"
          variant="outlined"
          startIcon={
            testingDelay ? <CircularProgress size={14} /> : <SpeedRounded />
          }
          onClick={catalog.testDelay}
          disabled={!groupName || nodes.length === 0 || testingDelay}
          sx={{ fontWeight: 900 }}
        >
          {testingDelay
            ? t('layout.components.nodes.actions.testing')
            : t('layout.components.nodes.actions.test')}
        </Button>
      }
    >
      <Stack
        spacing={2}
        sx={{
          maxWidth: 980,
          mx: 'auto',
          py: { xs: 1.5, sm: 2 },
        }}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
        >
          <Box>
            <Typography variant="h5" fontWeight={950}>
              {t('layout.components.nodes.heading')}
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.25 }}
            >
              {connected
                ? t('layout.components.nodes.connectedHint')
                : t('layout.components.nodes.readyHint')}
            </Typography>
          </Box>
          <Chip
            label={t('layout.components.nodes.count', {
              count: nodes.length,
            })}
            color="primary"
            variant="outlined"
            sx={{ fontWeight: 900 }}
          />
        </Stack>

        <TextField
          hiddenLabel
          fullWidth
          size="small"
          variant="outlined"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('layout.components.nodes.search.placeholder')}
          inputProps={{
            'aria-label': t('layout.components.nodes.search.placeholder'),
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded
                    sx={{ color: 'text.secondary', fontSize: 19 }}
                  />
                </InputAdornment>
              ),
            },
          }}
          sx={{
            maxWidth: 380,
            '& .MuiOutlinedInput-root': {
              bgcolor: tokens.surface,
              borderRadius: designTokens.radius.pill,
              '& fieldset': { borderColor: tokens.outline },
              '&:hover fieldset': { borderColor: tokens.outlineStrong },
              '&.Mui-focused fieldset': {
                borderColor: 'primary.main',
              },
            },
          }}
        />

        {recommendedNode && recommendedDelay > 0 && (
          <Paper variant="hero" sx={{ p: { xs: 1.5, sm: 2 } }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.5}
              alignItems={{ xs: 'stretch', sm: 'center' }}
              justifyContent="space-between"
            >
              <Stack
                direction="row"
                spacing={1.25}
                alignItems="center"
                minWidth={0}
              >
                <Box
                  sx={{
                    display: 'grid',
                    placeItems: 'center',
                    width: 38,
                    height: 38,
                    borderRadius: designTokens.radius.md,
                    color: 'secondary.main',
                    bgcolor: alpha(theme.palette.secondary.main, 0.12),
                    flex: '0 0 auto',
                  }}
                >
                  <BoltRounded fontSize="small" />
                </Box>
                <Box minWidth={0}>
                  <Typography
                    variant="overline"
                    sx={{ color: 'secondary.main', fontWeight: 900 }}
                  >
                    {t('layout.components.nodes.smart.title')}
                  </Typography>
                  <Typography variant="body1" fontWeight={900} noWrap>
                    {recommendedNode.displayName}
                  </Typography>
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <Box
                      aria-hidden="true"
                      sx={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        bgcolor: getDelayColor(recommendedDelay),
                        flex: '0 0 auto',
                      }}
                    />
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {t('layout.components.nodes.smart.hint')} ·{' '}
                      {getDelayLabel(recommendedDelay)}
                    </Typography>
                  </Stack>
                </Box>
              </Stack>
              <Button
                variant="outlined"
                size="small"
                onClick={() => catalog.selectNode(recommendedNode)}
                disabled={recommendedNode.key === selectedKey}
                sx={{ flex: '0 0 auto' }}
              >
                {t('layout.components.nodes.smart.action')}
              </Button>
            </Stack>
          </Paper>
        )}

        <Stack spacing={1.5}>
          {regions.map((region) => {
            const regionBestDelay = region.nodes.reduce((best, node) => {
              const delay = getNodeDelay(node)
              if (!Number.isFinite(delay) || delay <= 0) return best
              return best === -1 || delay < best ? delay : best
            }, -1)

            return (
              <Paper
                key={region.name}
                variant="surface"
                sx={{ overflow: 'hidden' }}
              >
                <Stack
                  component="header"
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  justifyContent="space-between"
                  sx={{ px: { xs: 1.5, sm: 2 }, py: 1.25 }}
                >
                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    minWidth={0}
                  >
                    <Typography
                      component="span"
                      sx={{ fontSize: 20, lineHeight: 1 }}
                    >
                      {getRegionFlag(region.name)}
                    </Typography>
                    <Typography variant="subtitle1" fontWeight={900} noWrap>
                      {region.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {t('layout.components.nodes.count', {
                        count: region.nodes.length,
                      })}
                    </Typography>
                  </Stack>
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <Box
                      aria-hidden="true"
                      sx={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        bgcolor: getDelayColor(regionBestDelay),
                        flex: '0 0 auto',
                      }}
                    />
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {getDelayLabel(regionBestDelay)}
                    </Typography>
                  </Stack>
                </Stack>

                <Box>
                  {region.nodes.map((node, index) => {
                    const selected =
                      selectedKey !== '' && selectedKey === node.key
                    const delay = getNodeDelay(node)

                    return (
                      <ButtonBase
                        key={`${node.key}:${node.name}`}
                        component="button"
                        type="button"
                        aria-pressed={selected}
                        aria-label={node.displayName}
                        disabled={selected}
                        onClick={() => catalog.selectNode(node)}
                        sx={{
                          width: '100%',
                          minHeight: 58,
                          display: 'flex',
                          justifyContent: 'flex-start',
                          px: { xs: 1.5, sm: 2 },
                          py: 1.25,
                          textAlign: 'left',
                          borderTop:
                            index === 0
                              ? 'none'
                              : `1px solid ${tokens.outline}`,
                          borderLeft: '3px solid',
                          borderLeftColor: selected
                            ? 'primary.main'
                            : 'transparent',
                          borderRadius: designTokens.radius.sm,
                          color: 'text.primary',
                          bgcolor: selected
                            ? alpha(theme.palette.primary.main, 0.12)
                            : 'transparent',
                          transition: theme.transitions.create([
                            'background-color',
                            'border-color',
                          ]),
                          '&:hover': {
                            bgcolor: selected
                              ? alpha(theme.palette.primary.main, 0.12)
                              : alpha(theme.palette.primary.main, 0.06),
                          },
                          '&:focus-visible': {
                            outline: `2px solid ${alpha(theme.palette.primary.main, 0.6)}`,
                            outlineOffset: -2,
                          },
                        }}
                      >
                        <Stack
                          direction="row"
                          spacing={1}
                          alignItems="center"
                          width="100%"
                          minWidth={0}
                        >
                          <Typography
                            variant="body1"
                            fontWeight={800}
                            noWrap
                            minWidth={0}
                          >
                            {getNodeRouteLabel(node.displayName)}
                          </Typography>
                          <Stack
                            direction="row"
                            spacing={0.75}
                            alignItems="center"
                            sx={{ ml: 'auto', flex: '0 0 auto' }}
                          >
                            <Box
                              aria-hidden="true"
                              sx={{
                                width: 8,
                                height: 8,
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
                            {selected && (
                              <CheckCircleRounded
                                color="primary"
                                sx={{ fontSize: 19 }}
                              />
                            )}
                          </Stack>
                        </Stack>
                      </ButtonBase>
                    )
                  })}
                </Box>
              </Paper>
            )
          })}
        </Stack>

        {nodes.length === 0 && (
          <Paper
            variant="surface"
            sx={{
              p: 4,
              textAlign: 'center',
            }}
          >
            <Typography variant="h6" fontWeight={900}>
              {t('layout.components.nodes.empty.title')}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              {t('layout.components.nodes.empty.subtitle')}
            </Typography>
          </Paper>
        )}

        {nodes.length > 0 && filteredNodes.length === 0 && (
          <Paper variant="surface" sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h6" fontWeight={900}>
              {t('layout.components.nodes.empty.filteredTitle')}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              {t('layout.components.nodes.empty.filteredSubtitle')}
            </Typography>
          </Paper>
        )}
      </Stack>
    </BasePage>
  )
}

export default NodesPage
