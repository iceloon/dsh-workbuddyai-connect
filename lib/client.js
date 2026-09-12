window.__ModuleLoader__.load({
	id: "dsh-workbuddyai-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/**
		* Node-free constants and types shared by the Host and browser halves.
		*
		* @module dsh-workbuddyai-connect/status-paths
		*/
		/** Plugin-owned status endpoint consumed by its browser half. */
		const WORKBUDDYAI_STATUS_PATH = "/plugins/dsh-workbuddyai-connect/status";
		/**
		* Plugin-owned control endpoint.
		*
		* Separate from the status route because it accepts writes: the status route's
		* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
		* not the same as authorizing a state-changing action. This route therefore also
		* requires the in-process key the browser half receives with the status document.
		*/
		const WORKBUDDYAI_CONTROL_PATH = "/plugins/dsh-workbuddyai-connect/control";
		//#endregion
		//#region src/client/WorkBuddyAiPluginCard.tsx
		/**
		* WorkBuddy AI status and policy card, contributed to Harness Plugin
		* configuration.
		*
		* The card is the plugin's only interactive surface. It reports the account and
		* remaining credit, and it owns the two decisions a user actually makes here:
		* which models the picker may show (the free-only filter), and whether reasoning
		* effort may be probed.
		*
		* Every action goes through the host's control route, which re-validates the
		* loopback origin and the in-process key. The card holds no credential and
		* cannot reach the upstream directly.
		*
		* @module dsh-workbuddyai-connect/client/WorkBuddyAiPluginCard
		*/
		/** How often the card re-reads the status document while it is open. */
		const POLL_INTERVAL_MS = 6e4;
		const cardStyle = {
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-module-platform)"
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			border: 0,
			padding: "13px 14px",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer"
		};
		const headTextStyle = {
			display: "flex",
			minWidth: 0,
			flexDirection: "column",
			gap: 3
		};
		const nameStyle = {
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600
		};
		const descriptionStyle = {
			fontSize: 13,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const chevronStyle = {
			flex: "0 0 auto",
			fontSize: 18,
			lineHeight: 1,
			transition: "transform 120ms ease"
		};
		const cardBodyStyle = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			padding: "16px 14px 18px"
		};
		const bodyStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		const statusStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			fontSize: 15,
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const buttonStyle = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		const errorStyle = {
			...bodyStyle,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const sectionStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			paddingTop: 16
		};
		const sectionTitleStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const quotaGroupStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const quotaLabelStyle = {
			display: "flex",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const modelRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12,
			padding: "6px 0"
		};
		const modelBadgeStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap"
		};
		const modelRateStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const chipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			color: "var(--dsw-alias-state-success-primary, #22a06b)"
		};
		const mutedChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const progressTrackStyle = {
			height: 8,
			overflow: "hidden",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))"
		};
		const tabBarStyle = {
			display: "flex",
			gap: 4,
			marginTop: 4,
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const tabStyle = {
			padding: "6px 12px",
			border: 0,
			borderBottom: "2px solid transparent",
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			cursor: "pointer"
		};
		const tabActiveStyle = {
			borderBottom: "2px solid var(--dsw-alias-brand-primary)",
			color: "var(--dsw-alias-label-primary)"
		};
		const SCOPE_OPTIONS = [{
			scope: "free",
			labelKey: "scopeFree",
			hintKey: "scopeFreeHint"
		}, {
			scope: "all",
			labelKey: "scopeAll",
			hintKey: "scopeAllHint"
		}];
		/** Format a credit count without a locale dependency the card cannot assume. */
		function formatCount(value) {
			return value.toLocaleString();
		}
		/** Format an epoch millisecond timestamp for display, degrading to a raw value. */
		function formatTime(value) {
			if (value === void 0) return "";
			try {
				return new Date(value).toLocaleString();
			} catch {
				return String(value);
			}
		}
		/** Format a context window as a compact token count (`1M`, `192K`). */
		function formatContext(tokens) {
			if (tokens >= 1e6) return `${Math.round(tokens / 1e5) / 10}M`;
			if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}K`;
			return String(tokens);
		}
		/** Localize an upstream promotional badge label, with an unknown-badge fallback. */
		function modelBadgeLabel(badge, t) {
			if (badge === "限时免费") return t("freeModel");
			return badge;
		}
		/**
		* POST one control action with the in-process key.
		*
		* The key travels in a header rather than the body so it never lands in a log
		* line that records payloads, and the request carries no credential of its own.
		*/
		async function postControl(key, body) {
			try {
				const response = await fetch(WORKBUDDYAI_CONTROL_PATH, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-WorkBuddyAi-Control-Key": key
					},
					body: JSON.stringify(body)
				});
				if (!response.ok) return {
					ok: false,
					error: (await response.text().catch(() => "")).slice(0, 200) || `HTTP ${response.status}`
				};
				const payload = await response.json().catch(() => void 0);
				if (payload !== void 0 && payload.state !== void 0 && payload.state !== "ok" && payload.state !== "cleared") return {
					ok: false,
					error: payload.reason ?? payload.state
				};
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/** One model row: name, badges, and why it is or is not selectable. */
		function ModelRow(props) {
			const { model, t } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: modelRowStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						minWidth: 0,
						flexDirection: "column",
						gap: 2
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: 14,
							color: "var(--dsw-alias-label-primary)"
						},
						children: model.name
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: modelRateStyle,
						children: [model.credits === void 0 ? model.id : t("rate", { rate: model.credits }), model.contextWindow === void 0 ? "" : ` · ${t("contextWindow", { tokens: formatContext(model.contextWindow) })}`]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: modelBadgeStyle,
					children: [
						(model.badges ?? []).map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: chipStyle,
							children: modelBadgeLabel(badge, t)
						}, badge)),
						model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: chipStyle,
							children: t("freeModel")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: mutedChipStyle,
							children: t("scopePaid")
						}),
						model.selectable === true ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: mutedChipStyle,
							children: t("scopeHidden")
						})
					]
				})]
			});
		}
		/**
		* The plugin card.
		*
		* Everything it renders comes from one status document; the control route is
		* used only to change state, and a successful change triggers a re-read so the
		* card never shows an optimistic value the host did not accept.
		*/
		function WorkBuddyAiPluginCard(props) {
			const t = props.t ?? ((key) => key);
			const [open, setOpen] = (0, react.useState)(false);
			const [tab, setTab] = (0, react.useState)("status");
			const [status, setStatus] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const mounted = (0, react.useRef)(true);
			const load = (0, react.useCallback)(async () => {
				setLoading(true);
				try {
					const response = await fetch(WORKBUDDYAI_STATUS_PATH, { headers: { "Accept": "application/json" } });
					if (!response.ok) {
						setError(`${t("requestFailed")} (HTTP ${response.status})`);
						return;
					}
					const document = await response.json();
					if (!mounted.current) return;
					setStatus(document);
					setError(document.status === "error" ? document.message : void 0);
				} catch (cause) {
					if (!mounted.current) return;
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setLoading(false);
				}
			}, [t]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			(0, react.useEffect)(() => {
				if (!open) return;
				load();
				const timer = setInterval(() => {
					load();
				}, POLL_INTERVAL_MS);
				return () => {
					clearInterval(timer);
				};
			}, [open, load]);
			const signedIn = status !== void 0 && status.status === "signed-in";
			const controlKey = signedIn ? status.controlKey : void 0;
			const scope = signedIn ? status.scope ?? "free" : "free";
			const probe = signedIn ? status.probe : void 0;
			const models = signedIn ? status.models ?? [] : [];
			/** Run one control action, then re-read so the card reflects host state only. */
			const runControl = (0, react.useCallback)(async (body) => {
				if (controlKey === void 0) return;
				setBusy(true);
				try {
					const result = await postControl(controlKey, body);
					if (!result.ok) {
						setError(result.error ?? t("requestFailed"));
						return;
					}
					setError(void 0);
					await load();
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, [
				controlKey,
				load,
				t
			]);
			const onScope = (0, react.useCallback)((next) => {
				runControl({
					action: "setScope",
					scope: next
				});
			}, [runControl]);
			const onProbe = (0, react.useCallback)((model) => {
				runControl({
					action: "probe",
					model
				});
			}, [runControl]);
			const onClearProbe = (0, react.useCallback)(() => {
				runControl({ action: "clearProbe" });
			}, [runControl]);
			const credits = signedIn ? status.credits : void 0;
			const creditsError = signedIn ? status.creditsError : void 0;
			const accountRows = (0, react.useMemo)(() => credits?.accounts ?? [], [credits]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: headerStyle,
					"aria-expanded": open,
					onClick: () => {
						setOpen((value) => !value);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: headTextStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: nameStyle,
							children: t("title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: descriptionStyle,
							children: t("intro")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							...chevronStyle,
							transform: open ? "rotate(180deg)" : "none"
						},
						"aria-hidden": "true",
						children: "⌄"
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardBodyStyle,
					children: [
						loading && status === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: bodyStyle,
							children: t("loading")
						}) : null,
						status !== void 0 && status.status === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 10
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: rowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: statusStyle,
									children: t("signedOut")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: buttonStyle,
									onClick: () => {
										load();
									},
									disabled: loading,
									children: loading ? t("refreshing") : t("refresh")
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle,
								children: t("signedOutHint")
							})]
						}) : null,
						status !== void 0 && status.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: status.message
						}) : null,
						signedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: tabBarStyle,
									role: "tablist",
									children: ["status", "models"].map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										role: "tab",
										"aria-selected": tab === key,
										style: tab === key ? {
											...tabStyle,
											...tabActiveStyle
										} : tabStyle,
										onClick: () => {
											setTab(key);
										},
										children: key === "status" ? t("tabStatus") : t("tabModels")
									}, key))
								}),
								tab === "status" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: sectionStyle,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
											style: sectionTitleStyle,
											children: t("accountHeading")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: rowStyle,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: statusStyle,
												children: status.nickname === void 0 ? t("signedInAs", { nickname: "—" }) : t("signedInAs", { nickname: status.nickname })
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle,
												onClick: () => {
													load();
												},
												disabled: loading,
												children: loading ? t("refreshing") : t("refresh")
											})]
										}),
										status.expiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("accessTokenExpires", { time: formatTime(status.expiresAt) })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
											style: sectionTitleStyle,
											children: t("creditsHeading")
										}),
										creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: errorStyle,
											children: t("creditsError", { message: creditsError })
										}),
										credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: quotaGroupStyle,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: bodyStyle,
												children: t("creditsTotal", { total: formatCount(credits.total) })
											}), accountRows.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: quotaGroupStyle,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: quotaLabelStyle,
													children: t("creditsDetailHeading")
												}), accountRows.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														display: "flex",
														flexDirection: "column",
														gap: 4
													},
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														style: quotaLabelStyle,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.packageName }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.size > 0 ? t("exactRemaining", {
															remain: formatCount(account.remain),
															size: formatCount(account.size)
														}) : t("creditPackageUnknownSize", { remain: formatCount(account.remain) }) })]
													}), account.size > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														style: progressTrackStyle,
														children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
															width: `${Math.max(0, Math.min(100, Math.round(account.remain / account.size * 100)))}%`,
															height: "100%",
															background: "var(--dsw-alias-brand-primary)"
														} })
													}) : null]
												}, account.packageName))]
											})]
										})
									]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: sectionStyle,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
											style: sectionTitleStyle,
											children: t("scopeHeading")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												display: "flex",
												flexDirection: "column",
												gap: 8
											},
											children: SCOPE_OPTIONS.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												style: {
													display: "flex",
													alignItems: "flex-start",
													gap: 10,
													padding: "8px 10px",
													border: "1px solid var(--dsw-alias-border-l2)",
													borderRadius: 8,
													cursor: busy ? "default" : "pointer"
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "radio",
													name: "workbuddyai-model-scope",
													checked: scope === option.scope,
													disabled: busy || controlKey === void 0,
													onChange: () => {
														onScope(option.scope);
													},
													style: { marginTop: 3 }
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: {
														display: "flex",
														flexDirection: "column",
														gap: 2
													},
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														style: {
															fontSize: 14,
															color: "var(--dsw-alias-label-primary)"
														},
														children: [t(option.labelKey), scope === option.scope ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: {
																...mutedChipStyle,
																marginLeft: 8
															},
															children: t("scopeActive")
														}) : null]
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: modelRateStyle,
														children: t(option.hintKey)
													})]
												})]
											}, option.scope))
										}),
										busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("scopeSaving")
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
											style: sectionTitleStyle,
											children: t("modelsHeading")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: modelRateStyle,
											children: t("modelsIntro")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: modelRateStyle,
											children: status.priceSource === "builtin" ? t("priceSourceBuiltin") : t("priceSourceCache")
										}),
										status.priceSourcePath === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: modelRateStyle,
											children: t("priceSourcePath", { path: status.priceSourcePath })
										}),
										models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("modelsEmpty")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
											style: {
												margin: 0,
												padding: 0,
												listStyle: "none"
											},
											children: models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {
												model,
												t
											}, model.id))
										}),
										probe === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												display: "flex",
												flexDirection: "column",
												gap: 8
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
													style: sectionTitleStyle,
													children: t("probeHeading")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													style: modelRateStyle,
													children: t("probeIntro")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													style: modelRateStyle,
													children: t("probeCandidates", { count: probe.candidates.length })
												}),
												probe.candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
													style: bodyStyle,
													children: t("probeResultEmpty")
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: {
														display: "flex",
														flexDirection: "column",
														gap: 6
													},
													children: probe.candidates.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														style: rowStyle,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															style: bodyStyle,
															children: id
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															style: buttonStyle,
															disabled: busy || probe.running,
															onClick: () => {
																onProbe(id);
															},
															children: probe.running ? t("probeRunning", { model: id }) : t("probeStart")
														})]
													}, id))
												}),
												probe.results.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														display: "flex",
														flexDirection: "column",
														gap: 4
													},
													children: [probe.results.map((result) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														style: modelRateStyle,
														children: [result.validation === "validating" ? t("probeResultVerified", { levels: result.efforts.join(", ") || t("probeResultNoLevels") }) : result.validation === "non-validating" ? t("probeResultNotValidating") : t("probeResultUnknown"), ` · ${t("probeResultAt", { time: formatTime(result.probedAt) })}`]
													}, result.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														style: buttonStyle,
														disabled: busy,
														onClick: onClearProbe,
														children: t("probeClear")
													})]
												})
											]
										})
									]
								}),
								error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: {
										...errorStyle,
										paddingTop: 12
									},
									children: error
								})
							]
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Plugin-card copy, registered under the `settings.workbuddyai` locale namespace.
		*
		* @module dsh-workbuddyai-connect/client/locales
		*/
		const en = {
			title: "DSH WorkBuddy AI Connect",
			intro: "Use the models from the WorkBuddy AI desktop app (international) directly in DSH — free models by default.",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Sign in once in the WorkBuddy AI international desktop app; this plugin follows that sign-in automatically.",
			signedInAs: "Signed in as {nickname}",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			requestFailed: "Request failed",
			tabStatus: "Status",
			tabModels: "Models",
			accountHeading: "Account",
			creditsHeading: "Remaining credit",
			creditsTotal: "Total: {total}",
			creditsDetailHeading: "By package",
			percentRemaining: "{percent}% remaining",
			exactRemaining: "{remain} / {size} remaining",
			creditPackageUnknownSize: "{remain} remaining",
			creditsError: "Credit unavailable: {message}",
			scopeHeading: "Model scope",
			scopeFree: "Free models only",
			scopeFreeHint: "List only models the WorkBuddy product configuration prices at x0.00. Nothing here can spend credit.",
			scopeAll: "All models",
			scopeAllHint: "Also list paid models. Selecting one spends real credit at the rate shown next to its name.",
			scopeSaving: "Applying…",
			scopeFailed: "Could not change the model scope: {message}",
			scopeActive: "Active",
			scopePaid: "Paid",
			scopeHidden: "Hidden by the free-only filter",
			modelsHeading: "Models",
			modelsIntro: "Rates come from the WorkBuddy product configuration, which is the authority on price.",
			modelsEmpty: "No models are available right now.",
			freeModel: "Free",
			rate: "{rate} credits per message",
			contextWindow: "Context {tokens}",
			priceSourceCache: "Prices read from the WorkBuddy app cache",
			priceSourceBuiltin: "Prices from the plugin’s built-in free list (the app cache was not readable)",
			priceSourcePath: "Source: {path}",
			probeHeading: "Reasoning effort detection",
			probeIntro: "Some models reason but declare no selectable effort levels. Detecting which levels a model accepts sends a few real requests that may consume credit.",
			probeConsent: "Authorize detection",
			probeConsentHint: "Each detection sends test requests to one model to confirm its available reasoning levels, and may consume a small amount of credit.",
			probeLabel: "Reasoning levels",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeClear: "Clear detected results",
			probeCandidates: "Detectable models: {count}",
			probeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			probeConfirmAction: "Confirm",
			cancel: "Cancel",
			probeResultVerified: "Verified levels: {levels}",
			probeResultNotValidating: "This model does not check the effort parameter",
			probeResultUnknown: "Detection did not complete",
			probeResultAt: "Detected {time}",
			probeResultEmpty: "No detectable models right now.",
			probeResultNoLevels: "No tested levels were accepted.",
			probeFailed: "Detection failed: {message}"
		};
		const zh = {
			title: "DSH WorkBuddy AI Connect",
			intro: "在 DSH 中直接使用 WorkBuddy AI 桌面 App（国际版）的模型，默认只列出免费模型。",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "在 WorkBuddy AI 国际版桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			signedInAs: "已登录：{nickname}",
			accessTokenExpires: "访问令牌 {time} 过期（自动续期）",
			refresh: "刷新",
			refreshing: "正在刷新…",
			requestFailed: "请求失败",
			tabStatus: "状态",
			tabModels: "模型",
			accountHeading: "账号",
			creditsHeading: "剩余积分",
			creditsTotal: "合计：{total}",
			creditsDetailHeading: "按套餐",
			percentRemaining: "剩余 {percent}%",
			exactRemaining: "剩余 {remain} / {size}",
			creditPackageUnknownSize: "剩余 {remain}",
			creditsError: "积分查询失败：{message}",
			scopeHeading: "模型范围",
			scopeFree: "仅免费模型",
			scopeFreeHint: "只列出 WorkBuddy 产品配置中标价 x0.00 的模型，不会产生任何扣费。",
			scopeAll: "全部模型",
			scopeAllHint: "同时列出付费模型。选用付费模型会按名称后标注的倍率真实扣费。",
			scopeSaving: "正在应用…",
			scopeFailed: "切换模型范围失败：{message}",
			scopeActive: "当前生效",
			scopePaid: "付费",
			scopeHidden: "被「仅免费」过滤",
			modelsHeading: "模型",
			modelsIntro: "倍率来自 WorkBuddy 产品配置，它是计费的权威来源。",
			modelsEmpty: "当前没有可用模型。",
			freeModel: "免费",
			rate: "{rate} 积分/次",
			contextWindow: "上下文 {tokens}",
			priceSourceCache: "价格读取自 WorkBuddy 应用缓存",
			priceSourceBuiltin: "价格来自插件内置的免费名单（未能读取应用缓存）",
			priceSourcePath: "来源：{path}",
			probeHeading: "推理档位检测",
			probeIntro: "部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。",
			probeConsent: "授权检测",
			probeConsentHint: "每次检测会向该模型发送探测请求，以确认可用推理档位，可能消耗少量积分。",
			probeLabel: "推理等级",
			probeStart: "开始检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeClear: "清除已探测结果",
			probeCandidates: "可检测模型：{count} 个",
			probeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			probeConfirmAction: "确认检测",
			cancel: "取消",
			probeResultVerified: "已验证接受的档位：{levels}",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			probeResultAt: "检测于 {time}",
			probeResultEmpty: "当前没有可检测的模型。",
			probeResultNoLevels: "本次测试的档位均未被接受。",
			probeFailed: "检测失败：{message}"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddyai-connect-client";
		/**
		* Client services required by the Plugin configuration contribution.
		*
		* The `settings.plugin.item` slot is declared by
		* `@deepseek-ai/dsh-client-ui-settings-plugins`, and the card's copy registers
		* through `@deepseek-ai/dsh-client-locale`; both are named in the package's
		* `dsh.client.inject` list, so cordis has activated them before this plugin's
		* fiber starts.
		*/
		const inject = ["slots", "locale"];
		/**
		* Register the card copy and the WorkBuddy AI card under Plugin configuration.
		*
		* The body is wrapped so that a slot-API breaking change degrades to a
		* `console.error` instead of throwing into the DSH loader and raising the
		* "Failed to load plugins" banner. The host provider keeps working: the
		* `workbuddyai` model channel is unaffected, and
		* `dsh-workbuddyai-connect status` reports host health via the heartbeat file.
		*/
		function apply(ctx) {
			try {
				const namespace = "settings.workbuddyai";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddyai-connect: settings copy");
				const t = ctx.locale.bind(namespace);
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "workbuddyai",
					locale: namespace,
					inject: () => ({ t })
				}, WorkBuddyAiPluginCard));
			} catch (error) {
				console.error("[dsh-workbuddyai-connect] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
