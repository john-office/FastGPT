import React, {
  useCallback,
  useRef,
  useState,
  useMemo,
  forwardRef,
  useImperativeHandle,
  ForwardedRef,
  useEffect
} from 'react';
import Script from 'next/script';
import type {
  AIChatItemValueItemType,
  ChatSiteItemType,
  UserChatItemValueItemType
} from '@fastgpt/global/core/chat/type.d';
import { useToast } from '@fastgpt/web/hooks/useToast';
import { getErrText } from '@fastgpt/global/common/error/utils';
import { Box, Flex, Checkbox, BoxProps } from '@chakra-ui/react';
import { EventNameEnum, eventBus } from '@/web/common/utils/eventbus';
import { chats2GPTMessages } from '@fastgpt/global/core/chat/adapt';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/router';
import { useSystemStore } from '@/web/common/system/useSystemStore';
import { useTranslation } from 'next-i18next';
import {
  closeCustomFeedback,
  updateChatAdminFeedback,
  updateChatUserFeedback
} from '@/web/core/chat/api';
import type { AdminMarkType } from './components/SelectMarkCollection';

import MyTooltip from '@fastgpt/web/components/common/MyTooltip';

import { postQuestionGuide } from '@/web/core/ai/api';
import type {
  ComponentRef,
  ChatBoxInputType,
  ChatBoxInputFormType,
  SendPromptFnType
} from './type.d';
import type { StartChatFnProps, generatingMessageProps } from '../type';
import ChatInput from './Input/ChatInput';
import ChatBoxDivider from '../../Divider';
import { OutLinkChatAuthProps } from '@fastgpt/global/support/permission/chat';
import { getNanoid } from '@fastgpt/global/common/string/tools';
import {
  ChatItemValueTypeEnum,
  ChatRoleEnum,
  ChatStatusEnum
} from '@fastgpt/global/core/chat/constants';
import {
  checkIsInteractiveByHistories,
  formatChatValue2InputType,
  setUserSelectResultToHistories
} from './utils';
import { textareaMinH } from './constants';
import { SseResponseEventEnum } from '@fastgpt/global/core/workflow/runtime/constants';
import ChatProvider, { ChatBoxContext, ChatProviderProps } from './Provider';

import ChatItem from './components/ChatItem';

import dynamic from 'next/dynamic';
import type { StreamResponseType } from '@/web/common/api/fetch';
import { useContextSelector } from 'use-context-selector';
import { useSystem } from '@fastgpt/web/hooks/useSystem';
import { useCreation, useMemoizedFn, useThrottleFn } from 'ahooks';
import MyIcon from '@fastgpt/web/components/common/Icon';
import { mergeChatResponseData } from '@fastgpt/global/core/chat/utils';

const ResponseTags = dynamic(() => import('./components/ResponseTags'));
const FeedbackModal = dynamic(() => import('./components/FeedbackModal'));
const ReadFeedbackModal = dynamic(() => import('./components/ReadFeedbackModal'));
const SelectMarkCollection = dynamic(() => import('./components/SelectMarkCollection'));
const Empty = dynamic(() => import('./components/Empty'));
const WelcomeBox = dynamic(() => import('./components/WelcomeBox'));
const VariableInput = dynamic(() => import('./components/VariableInput'));

enum FeedbackTypeEnum {
  user = 'user',
  admin = 'admin',
  hidden = 'hidden'
}

type Props = OutLinkChatAuthProps &
  ChatProviderProps & {
    feedbackType?: `${FeedbackTypeEnum}`;
    showMarkIcon?: boolean; // admin mark dataset
    showVoiceIcon?: boolean;
    showEmptyIntro?: boolean;
    userAvatar?: string;
    active?: boolean; // can use
    appId: string;
    ScrollData: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
      ScrollContainerRef?: React.RefObject<HTMLDivElement>;
    } & BoxProps) => React.JSX.Element;
    // not chat test params

    onStartChat?: (e: StartChatFnProps) => Promise<
      StreamResponseType & {
        isNewChat?: boolean;
      }
    >;
    onDelMessage?: (e: { contentId: string }) => void;
  };

const ChatBox = (
  {
    feedbackType = FeedbackTypeEnum.hidden,
    showMarkIcon = false,
    showVoiceIcon = true,
    showEmptyIntro = false,
    appAvatar,
    userAvatar,
    active = true,
    appId,
    chatId,
    shareId,
    outLinkUid,
    teamId,
    teamToken,
    onStartChat,
    onDelMessage,
    ScrollData
  }: Props,
  ref: ForwardedRef<ComponentRef>
) => {
  const ChatBoxRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { setLoading, feConfigs } = useSystemStore();
  const { isPc } = useSystem();
  const TextareaDom = useRef<HTMLTextAreaElement>(null);
  const chatController = useRef(new AbortController());
  const questionGuideController = useRef(new AbortController());
  const pluginController = useRef(new AbortController());
  const isNewChatReplace = useRef(false);

  const [feedbackId, setFeedbackId] = useState<string>();
  const [readFeedbackData, setReadFeedbackData] = useState<{
    dataId: string;
    content: string;
  }>();
  const [adminMarkData, setAdminMarkData] = useState<AdminMarkType & { dataId: string }>();
  const [questionGuides, setQuestionGuide] = useState<string[]>([]);

  const {
    welcomeText,
    variableList,
    allVariableList,
    questionGuide,
    startSegmentedAudio,
    finishSegmentedAudio,
    setAudioPlayingChatId,
    splitText2Audio,
    chatHistories,
    setChatHistories,
    variablesForm,
    isChatting
  } = useContextSelector(ChatBoxContext, (v) => v);

  // Workflow running, there are user input or selection
  const isInteractive = useMemo(
    () => checkIsInteractiveByHistories(chatHistories),
    [chatHistories]
  );

  // compute variable input is finish.
  const chatForm = useForm<ChatBoxInputFormType>({
    defaultValues: {
      input: '',
      files: [],
      chatStarted: false
    }
  });
  const { setValue, watch } = chatForm;
  const chatStartedWatch = watch('chatStarted');
  const chatStarted = chatStartedWatch || chatHistories.length > 0 || variableList.length === 0;

  // 滚动到底部
  const scrollToBottom = useMemoizedFn((behavior: 'smooth' | 'auto' = 'smooth', delay = 0) => {
    setTimeout(() => {
      if (!ChatBoxRef.current) {
        setTimeout(() => {
          scrollToBottom(behavior);
        }, 500);
      } else {
        ChatBoxRef.current.scrollTo({
          top: ChatBoxRef.current.scrollHeight,
          behavior
        });
      }
    }, delay);
  });

  // 聊天信息生成中……获取当前滚动条位置，判断是否需要滚动到底部
  const { run: generatingScroll } = useThrottleFn(
    (force?: boolean) => {
      if (!ChatBoxRef.current) return;
      const isBottom =
        ChatBoxRef.current.scrollTop + ChatBoxRef.current.clientHeight + 150 >=
        ChatBoxRef.current.scrollHeight;

      if (isBottom || force) {
        scrollToBottom('auto');
      }
    },
    {
      wait: 100
    }
  );

  const generatingMessage = useMemoizedFn(
    ({
      event,
      text = '',
      status,
      name,
      tool,
      interactive,
      autoTTSResponse,
      variables
    }: generatingMessageProps & { autoTTSResponse?: boolean }) => {
      setChatHistories((state) =>
        state.map((item, index) => {
          if (index !== state.length - 1) return item;
          if (item.obj !== ChatRoleEnum.AI) return item;

          autoTTSResponse && splitText2Audio(formatChatValue2InputType(item.value).text || '');

          const lastValue: AIChatItemValueItemType = JSON.parse(
            JSON.stringify(item.value[item.value.length - 1])
          );

          if (event === SseResponseEventEnum.flowNodeStatus && status) {
            return {
              ...item,
              status,
              moduleName: name
            };
          } else if (
            (event === SseResponseEventEnum.answer || event === SseResponseEventEnum.fastAnswer) &&
            text
          ) {
            if (!lastValue || !lastValue.text) {
              const newValue: AIChatItemValueItemType = {
                type: ChatItemValueTypeEnum.text,
                text: {
                  content: text
                }
              };
              return {
                ...item,
                value: item.value.concat(newValue)
              };
            } else {
              lastValue.text.content += text;
              return {
                ...item,
                value: item.value.slice(0, -1).concat(lastValue)
              };
            }
          } else if (event === SseResponseEventEnum.toolCall && tool) {
            const val: AIChatItemValueItemType = {
              type: ChatItemValueTypeEnum.tool,
              tools: [tool]
            };
            return {
              ...item,
              value: item.value.concat(val)
            };
          } else if (
            event === SseResponseEventEnum.toolParams &&
            tool &&
            lastValue.type === ChatItemValueTypeEnum.tool &&
            lastValue?.tools
          ) {
            lastValue.tools = lastValue.tools.map((item) => {
              if (item.id === tool.id) {
                item.params += tool.params;
              }
              return item;
            });
            return {
              ...item,
              value: item.value.slice(0, -1).concat(lastValue)
            };
          } else if (event === SseResponseEventEnum.toolResponse && tool) {
            // replace tool response
            return {
              ...item,
              value: item.value.map((val) => {
                if (val.type === ChatItemValueTypeEnum.tool && val.tools) {
                  const tools = val.tools.map((item) =>
                    item.id === tool.id ? { ...item, response: tool.response } : item
                  );
                  return {
                    ...val,
                    tools
                  };
                }
                return val;
              })
            };
          } else if (event === SseResponseEventEnum.updateVariables && variables) {
            variablesForm.reset(variables);
          } else if (event === SseResponseEventEnum.interactive) {
            const val: AIChatItemValueItemType = {
              type: ChatItemValueTypeEnum.interactive,
              interactive
            };

            return {
              ...item,
              value: item.value.concat(val)
            };
          }

          return item;
        })
      );

      const forceScroll = event === SseResponseEventEnum.interactive;
      generatingScroll(forceScroll);
    }
  );

  // 重置输入内容
  const resetInputVal = useMemoizedFn(({ text = '', files = [] }: ChatBoxInputType) => {
    if (!TextareaDom.current) return;
    setValue('files', files);
    setValue('input', text);

    setTimeout(() => {
      /* 回到最小高度 */
      if (TextareaDom.current) {
        TextareaDom.current.style.height =
          text === '' ? textareaMinH : `${TextareaDom.current.scrollHeight}px`;
      }
    }, 100);
  });

  // create question guide
  const createQuestionGuide = useCallback(
    async ({ histories }: { histories: ChatSiteItemType[] }) => {
      if (!questionGuide || chatController.current?.signal?.aborted) return;
      try {
        const abortSignal = new AbortController();
        questionGuideController.current = abortSignal;

        const result = await postQuestionGuide(
          {
            messages: chats2GPTMessages({ messages: histories, reserveId: false }).slice(-6),
            shareId,
            outLinkUid,
            teamId,
            teamToken
          },
          abortSignal
        );
        if (Array.isArray(result)) {
          setQuestionGuide(result);
          setTimeout(() => {
            scrollToBottom();
          }, 100);
        }
      } catch (error) {}
    },
    [questionGuide, shareId, outLinkUid, teamId, teamToken, scrollToBottom]
  );

  /* Abort chat completions, questionGuide */
  const abortRequest = useMemoizedFn(() => {
    chatController.current?.abort('stop');
    questionGuideController.current?.abort('stop');
    pluginController.current?.abort('stop');
  });

  /**
   * user confirm send prompt
   */
  const sendPrompt: SendPromptFnType = useMemoizedFn(
    ({
      text = '',
      files = [],
      history = chatHistories,
      autoTTSResponse = false,
      isInteractivePrompt = false
    }) => {
      variablesForm.handleSubmit(
        async (variables) => {
          if (!onStartChat) return;
          if (isChatting) {
            toast({
              title: t('chat:is_chatting'),
              status: 'warning'
            });
            return;
          }

          // Abort the previous request
          abortRequest();
          questionGuideController.current?.abort('stop');

          text = text.trim();

          if (!text && files.length === 0) {
            toast({
              title: t('chat:content_empty'),
              status: 'warning'
            });
            return;
          }

          // Only declared variables are kept
          const requestVariables: Record<string, any> = {};
          allVariableList?.forEach((item) => {
            requestVariables[item.key] = variables[item.key] || '';
          });

          const responseChatId = getNanoid(24);

          // set auto audio playing
          if (autoTTSResponse) {
            await startSegmentedAudio();
            setAudioPlayingChatId(responseChatId);
          }

          const newChatList: ChatSiteItemType[] = [
            ...history,
            {
              dataId: getNanoid(24),
              obj: ChatRoleEnum.Human,
              value: [
                ...files.map((file) => ({
                  type: ChatItemValueTypeEnum.file,
                  file: {
                    type: file.type,
                    name: file.name,
                    url: file.url || '',
                    icon: file.icon || ''
                  }
                })),
                ...(text
                  ? [
                      {
                        type: ChatItemValueTypeEnum.text,
                        text: {
                          content: text
                        }
                      }
                    ]
                  : [])
              ] as UserChatItemValueItemType[],
              status: ChatStatusEnum.finish
            },
            {
              dataId: responseChatId,
              obj: ChatRoleEnum.AI,
              value: [
                {
                  type: ChatItemValueTypeEnum.text,
                  text: {
                    content: ''
                  }
                }
              ],
              status: ChatStatusEnum.loading
            }
          ];

          // Update histories(Interactive input does not require new session rounds)
          setChatHistories(
            isInteractivePrompt
              ? // 把交互的结果存储到对话记录中，交互模式下，不需要新的会话轮次
                setUserSelectResultToHistories(newChatList.slice(0, -2), text)
              : newChatList
          );

          // 清空输入内容
          resetInputVal({});
          setQuestionGuide([]);
          scrollToBottom('smooth', 100);

          try {
            // create abort obj
            const abortSignal = new AbortController();
            chatController.current = abortSignal;

            // 这里，无论是否为交互模式，最后都是 Human 的消息。
            const messages = chats2GPTMessages({
              messages: newChatList.slice(0, -1),
              reserveId: true
            });

            const {
              responseData,
              responseText,
              isNewChat = false
            } = await onStartChat({
              messages, // 保证最后一条是 Human 的消息
              responseChatItemId: responseChatId,
              controller: abortSignal,
              generatingMessage: (e) => generatingMessage({ ...e, autoTTSResponse }),
              variables: requestVariables
            });

            isNewChatReplace.current = isNewChat;

            // Set last chat finish status
            let newChatHistories: ChatSiteItemType[] = [];
            setChatHistories((state) => {
              newChatHistories = state.map((item, index) => {
                if (index !== state.length - 1) return item;
                return {
                  ...item,
                  status: ChatStatusEnum.finish,
                  responseData: item.responseData
                    ? mergeChatResponseData([...item.responseData, ...responseData])
                    : responseData
                };
              });
              return newChatHistories;
            });

            setTimeout(() => {
              if (!checkIsInteractiveByHistories(newChatHistories)) {
                createQuestionGuide({
                  histories: newChatHistories
                });
              }

              generatingScroll(true);
              isPc && TextareaDom.current?.focus();
            }, 100);

            // tts audio
            autoTTSResponse && splitText2Audio(responseText, true);
          } catch (err: any) {
            toast({
              title: t(getErrText(err, 'core.chat.error.Chat error') as any),
              status: 'error',
              duration: 5000,
              isClosable: true
            });

            if (!err?.responseText) {
              resetInputVal({ text, files });
              // 这里的 newChatList 没包含用户交互输入的内容，所以重置后刚好是正确的。
              setChatHistories(newChatList.slice(0, newChatList.length - 2));
            }

            // set finish status
            setChatHistories((state) =>
              state.map((item, index) => {
                if (index !== state.length - 1) return item;
                return {
                  ...item,
                  status: ChatStatusEnum.finish
                };
              })
            );
          }

          autoTTSResponse && finishSegmentedAudio();
        },
        (err) => {
          console.log(err);
        }
      )();
    }
  );

  // retry input
  const retryInput = useMemoizedFn((dataId?: string) => {
    if (!dataId || !onDelMessage) return;

    return async () => {
      setLoading(true);
      const index = chatHistories.findIndex((item) => item.dataId === dataId);
      const delHistory = chatHistories.slice(index);
      try {
        await Promise.all(
          delHistory.map((item) => {
            if (item.dataId) {
              return onDelMessage({ contentId: item.dataId });
            }
          })
        );
        setChatHistories((state) => (index === 0 ? [] : state.slice(0, index)));

        sendPrompt({
          ...formatChatValue2InputType(delHistory[0].value),
          history: chatHistories.slice(0, index)
        });
      } catch (error) {
        toast({
          status: 'warning',
          title: getErrText(error, 'Retry failed')
        });
      }
      setLoading(false);
    };
  });
  // delete one message(One human and the ai response)
  const delOneMessage = useMemoizedFn((dataId?: string) => {
    if (!dataId || !onDelMessage) return;
    return () => {
      setChatHistories((state) => {
        let aiIndex = -1;

        return state.filter((chat, i) => {
          if (chat.dataId === dataId) {
            aiIndex = i + 1;
            onDelMessage({
              contentId: dataId
            });
            return false;
          } else if (aiIndex === i && chat.obj === ChatRoleEnum.AI && chat.dataId) {
            onDelMessage({
              contentId: chat.dataId
            });
            return false;
          }
          return true;
        });
      });
    };
  });
  // admin mark
  const onMark = useMemoizedFn((chat: ChatSiteItemType, q = '') => {
    if (!showMarkIcon || chat.obj !== ChatRoleEnum.AI) return;

    return () => {
      if (!chat.dataId) return;

      if (chat.adminFeedback) {
        setAdminMarkData({
          dataId: chat.dataId,
          datasetId: chat.adminFeedback.datasetId,
          collectionId: chat.adminFeedback.collectionId,
          feedbackDataId: chat.adminFeedback.feedbackDataId,
          q: chat.adminFeedback.q || q || '',
          a: chat.adminFeedback.a
        });
      } else {
        setAdminMarkData({
          dataId: chat.dataId,
          q,
          a: formatChatValue2InputType(chat.value).text
        });
      }
    };
  });
  const onAddUserLike = useMemoizedFn((chat: ChatSiteItemType) => {
    if (
      feedbackType !== FeedbackTypeEnum.user ||
      chat.obj !== ChatRoleEnum.AI ||
      chat.userBadFeedback
    )
      return;
    return () => {
      if (!chat.dataId || !chatId || !appId) return;

      const isGoodFeedback = !!chat.userGoodFeedback;
      setChatHistories((state) =>
        state.map((chatItem) =>
          chatItem.dataId === chat.dataId
            ? {
                ...chatItem,
                userGoodFeedback: isGoodFeedback ? undefined : 'yes'
              }
            : chatItem
        )
      );
      try {
        updateChatUserFeedback({
          appId,
          chatId,
          teamId,
          teamToken,
          dataId: chat.dataId,
          shareId,
          outLinkUid,
          userGoodFeedback: isGoodFeedback ? undefined : 'yes'
        });
      } catch (error) {}
    };
  });
  const onCloseUserLike = useMemoizedFn((chat: ChatSiteItemType) => {
    if (feedbackType !== FeedbackTypeEnum.admin) return;
    return () => {
      if (!chat.dataId || !chatId || !appId) return;
      setChatHistories((state) =>
        state.map((chatItem) =>
          chatItem.dataId === chat.dataId ? { ...chatItem, userGoodFeedback: undefined } : chatItem
        )
      );
      updateChatUserFeedback({
        appId,
        teamId,
        teamToken,
        chatId,
        dataId: chat.dataId,
        userGoodFeedback: undefined
      });
    };
  });
  const onAddUserDislike = useMemoizedFn((chat: ChatSiteItemType) => {
    if (
      feedbackType !== FeedbackTypeEnum.user ||
      chat.obj !== ChatRoleEnum.AI ||
      chat.userGoodFeedback
    ) {
      return;
    }
    if (chat.userBadFeedback) {
      return () => {
        if (!chat.dataId || !chatId || !appId) return;
        setChatHistories((state) =>
          state.map((chatItem) =>
            chatItem.dataId === chat.dataId ? { ...chatItem, userBadFeedback: undefined } : chatItem
          )
        );
        try {
          updateChatUserFeedback({
            appId,
            chatId,
            dataId: chat.dataId,
            shareId,
            teamId,
            teamToken,
            outLinkUid
          });
        } catch (error) {}
      };
    } else {
      return () => setFeedbackId(chat.dataId);
    }
  });
  const onReadUserDislike = useMemoizedFn((chat: ChatSiteItemType) => {
    if (feedbackType !== FeedbackTypeEnum.admin || chat.obj !== ChatRoleEnum.AI) return;
    return () => {
      if (!chat.dataId) return;
      setReadFeedbackData({
        dataId: chat.dataId || '',
        content: chat.userBadFeedback || ''
      });
    };
  });
  const onCloseCustomFeedback = useMemoizedFn((chat: ChatSiteItemType, i: number) => {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.checked && appId && chatId && chat.dataId) {
        closeCustomFeedback({
          appId,
          chatId,
          dataId: chat.dataId,
          index: i
        });
        // update dom
        setChatHistories((state) =>
          state.map((chatItem) =>
            chatItem.obj === ChatRoleEnum.AI && chatItem.dataId === chat.dataId
              ? {
                  ...chatItem,
                  customFeedbacks: chatItem.customFeedbacks?.filter((_, index) => index !== i)
                }
              : chatItem
          )
        );
      }
    };
  });

  const showEmpty = useMemo(
    () =>
      feConfigs?.show_emptyChat &&
      showEmptyIntro &&
      chatHistories.length === 0 &&
      !variableList?.length &&
      !welcomeText,
    [
      chatHistories.length,
      feConfigs?.show_emptyChat,
      showEmptyIntro,
      variableList?.length,
      welcomeText
    ]
  );
  const statusBoxData = useCreation(() => {
    if (!isChatting) return;
    const chatContent = chatHistories[chatHistories.length - 1];
    if (!chatContent) return;

    return {
      status: chatContent.status || ChatStatusEnum.loading,
      name: t(chatContent.moduleName || ('' as any)) || t('common:common.Loading')
    };
  }, [chatHistories, isChatting, t]);

  // page change and abort request
  useEffect(() => {
    isNewChatReplace.current = false;
    setQuestionGuide([]);
    return () => {
      chatController.current?.abort('leave');
      if (!isNewChatReplace.current) {
        questionGuideController.current?.abort('leave');
      }
    };
  }, [router.query]);

  // add listener
  useEffect(() => {
    const windowMessage = ({ data }: MessageEvent<{ type: 'sendPrompt'; text: string }>) => {
      if (data?.type === 'sendPrompt' && data?.text) {
        sendPrompt({
          text: data.text
        });
      }
    };
    window.addEventListener('message', windowMessage);

    const fn: SendPromptFnType = (e) => {
      sendPrompt(e);
    };
    eventBus.on(EventNameEnum.sendQuestion, fn);
    eventBus.on(EventNameEnum.editQuestion, ({ text }: { text: string }) => {
      if (!text) return;
      resetInputVal({ text });
    });

    return () => {
      window.removeEventListener('message', windowMessage);
      eventBus.off(EventNameEnum.sendQuestion);
      eventBus.off(EventNameEnum.editQuestion);
    };
  }, [resetInputVal, sendPrompt]);

  // output data
  useImperativeHandle(ref, () => ({
    restartChat() {
      abortRequest();

      setChatHistories([]);
      setValue('chatStarted', false);
    },
    scrollToBottom(behavior = 'auto') {
      scrollToBottom(behavior, 500);
    }
  }));

  const RenderRecords = useMemo(() => {
    return (
      <ScrollData
        ScrollContainerRef={ChatBoxRef}
        flex={'1 0 0'}
        h={0}
        w={'100%'}
        overflow={'overlay'}
        px={[4, 0]}
        pb={3}
      >
        <Box id="chat-container" maxW={['100%', '92%']} h={'100%'} mx={'auto'}>
          {showEmpty && <Empty />}
          {!!welcomeText && <WelcomeBox welcomeText={welcomeText} />}
          {/* variable input */}
          {!!variableList?.length && (
            <VariableInput chatStarted={chatStarted} chatForm={chatForm} />
          )}
          {/* chat history */}
          <Box id={'history'}>
            {chatHistories.map((item, index) => (
              <Box key={item.dataId} py={5}>
                {item.obj === ChatRoleEnum.Human && (
                  <ChatItem
                    type={item.obj}
                    avatar={userAvatar}
                    chat={item}
                    onRetry={retryInput(item.dataId)}
                    onDelete={delOneMessage(item.dataId)}
                    isLastChild={index === chatHistories.length - 1}
                  />
                )}
                {item.obj === ChatRoleEnum.AI && (
                  <>
                    <ChatItem
                      type={item.obj}
                      avatar={appAvatar}
                      chat={item}
                      isLastChild={index === chatHistories.length - 1}
                      {...{
                        showVoiceIcon,
                        shareId,
                        outLinkUid,
                        teamId,
                        teamToken,
                        statusBoxData,
                        questionGuides,
                        onMark: onMark(
                          item,
                          formatChatValue2InputType(chatHistories[index - 1]?.value)?.text
                        ),
                        onAddUserLike: onAddUserLike(item),
                        onCloseUserLike: onCloseUserLike(item),
                        onAddUserDislike: onAddUserDislike(item),
                        onReadUserDislike: onReadUserDislike(item)
                      }}
                    >
                      <ResponseTags
                        showTags={index !== chatHistories.length - 1 || !isChatting}
                        showDetail={!shareId && !teamId}
                        historyItem={item}
                      />

                      {/* custom feedback */}
                      {item.customFeedbacks && item.customFeedbacks.length > 0 && (
                        <Box>
                          <ChatBoxDivider
                            icon={'core/app/customFeedback'}
                            text={t('common:core.app.feedback.Custom feedback')}
                          />
                          {item.customFeedbacks.map((text, i) => (
                            <Box key={i}>
                              <MyTooltip
                                label={t('common:core.app.feedback.close custom feedback')}
                              >
                                <Checkbox
                                  onChange={onCloseCustomFeedback(item, i)}
                                  icon={<MyIcon name={'common/check'} w={'12px'} />}
                                >
                                  {text}
                                </Checkbox>
                              </MyTooltip>
                            </Box>
                          ))}
                        </Box>
                      )}
                      {/* admin mark content */}
                      {showMarkIcon && item.adminFeedback && (
                        <Box fontSize={'sm'}>
                          <ChatBoxDivider
                            icon="core/app/markLight"
                            text={t('common:core.chat.Admin Mark Content')}
                          />
                          <Box whiteSpace={'pre-wrap'}>
                            <Box color={'black'}>{item.adminFeedback.q}</Box>
                            <Box color={'myGray.600'}>{item.adminFeedback.a}</Box>
                          </Box>
                        </Box>
                      )}
                    </ChatItem>
                  </>
                )}
              </Box>
            ))}
          </Box>
        </Box>
      </ScrollData>
    );
  }, [
    ScrollData,
    appAvatar,
    chatForm,
    chatHistories,
    chatStarted,
    delOneMessage,
    isChatting,
    onAddUserDislike,
    onAddUserLike,
    onCloseCustomFeedback,
    onCloseUserLike,
    onMark,
    onReadUserDislike,
    outLinkUid,
    questionGuides,
    retryInput,
    shareId,
    showEmpty,
    showMarkIcon,
    showVoiceIcon,
    statusBoxData,
    t,
    teamId,
    teamToken,
    userAvatar,
    variableList?.length,
    welcomeText
  ]);

  return (
    <Flex flexDirection={'column'} h={'100%'} position={'relative'}>
      <Script src="/js/html2pdf.bundle.min.js" strategy="lazyOnload"></Script>
      {/* chat box container */}
      {RenderRecords}
      {/* message input */}
      {onStartChat && chatStarted && active && appId && !isInteractive && (
        <ChatInput
          onSendMessage={sendPrompt}
          onStop={() => chatController.current?.abort('stop')}
          TextareaDom={TextareaDom}
          resetInputVal={resetInputVal}
          chatForm={chatForm}
          appId={appId}
        />
      )}
      {/* user feedback modal */}
      {!!feedbackId && chatId && appId && (
        <FeedbackModal
          appId={appId}
          teamId={teamId}
          teamToken={teamToken}
          chatId={chatId}
          dataId={feedbackId}
          shareId={shareId}
          outLinkUid={outLinkUid}
          onClose={() => setFeedbackId(undefined)}
          onSuccess={(content: string) => {
            setChatHistories((state) =>
              state.map((item) =>
                item.dataId === feedbackId ? { ...item, userBadFeedback: content } : item
              )
            );
            setFeedbackId(undefined);
          }}
        />
      )}
      {/* admin read feedback modal */}
      {!!readFeedbackData && (
        <ReadFeedbackModal
          content={readFeedbackData.content}
          onClose={() => setReadFeedbackData(undefined)}
          onCloseFeedback={() => {
            setChatHistories((state) =>
              state.map((chatItem) =>
                chatItem.dataId === readFeedbackData.dataId
                  ? { ...chatItem, userBadFeedback: undefined }
                  : chatItem
              )
            );
            try {
              if (!chatId || !appId) return;
              updateChatUserFeedback({
                appId,
                chatId,
                dataId: readFeedbackData.dataId
              });
            } catch (error) {}
            setReadFeedbackData(undefined);
          }}
        />
      )}
      {/* admin mark data */}
      {!!adminMarkData && (
        <SelectMarkCollection
          adminMarkData={adminMarkData}
          setAdminMarkData={(e) => setAdminMarkData({ ...e, dataId: adminMarkData.dataId })}
          onClose={() => setAdminMarkData(undefined)}
          onSuccess={(adminFeedback) => {
            if (!appId || !chatId || !adminMarkData.dataId) return;
            updateChatAdminFeedback({
              appId,
              chatId,
              dataId: adminMarkData.dataId,
              ...adminFeedback
            });

            // update dom
            setChatHistories((state) =>
              state.map((chatItem) =>
                chatItem.dataId === adminMarkData.dataId
                  ? {
                      ...chatItem,
                      adminFeedback
                    }
                  : chatItem
              )
            );

            if (readFeedbackData && chatId && appId) {
              updateChatUserFeedback({
                appId,
                chatId,
                dataId: readFeedbackData.dataId,
                userBadFeedback: undefined
              });
              setChatHistories((state) =>
                state.map((chatItem) =>
                  chatItem.dataId === readFeedbackData.dataId
                    ? { ...chatItem, userBadFeedback: undefined }
                    : chatItem
                )
              );
              setReadFeedbackData(undefined);
            }
          }}
        />
      )}
    </Flex>
  );
};
const ForwardChatBox = forwardRef(ChatBox);

const ChatBoxContainer = (props: Props, ref: ForwardedRef<ComponentRef>) => {
  return (
    <ChatProvider {...props}>
      <ForwardChatBox {...props} ref={ref} />
    </ChatProvider>
  );
};

export default React.memo(forwardRef(ChatBoxContainer));
