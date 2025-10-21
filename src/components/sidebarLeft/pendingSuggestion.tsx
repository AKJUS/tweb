import {i18n} from '../../lib/langPack';
import {useAppState} from '../../stores/appState';
import Row from '../rowTsx';
import styles from './pendingSuggestion.module.scss';
import {render} from 'solid-js/web';
import {createEffect, createSignal, JSX, onMount, Show, splitProps} from 'solid-js';
import classNames from '../../helpers/string/classNames';
import wrapEmojiText from '../../lib/richTextProcessor/wrapEmojiText';
import {useIsSidebarCollapsed} from '../../stores/foldersSidebar';
import RippleElement from '../rippleElement';
import documentFragmentToNodes from '../../helpers/dom/documentFragmentToNodes';
import showFrozenPopup from '../popups/frozen';
import {useAppSettings} from '../../stores/appSettings';
import Button from '../buttonTsx';
import {toastNew} from '../toast';
import Animated from '../../helpers/solid/animations';
import uiNotificationsManager from '../../lib/appManagers/uiNotificationsManager';
import cancelEvent from '../../helpers/dom/cancelEvent';

const PendingSuggestion = (props: Parameters<typeof Row>[0] & {closable?: () => void}) => {
  // const [, rest] = splitProps(props, ['closable']);
  return (
    <Row
      {...props}
      class={classNames(styles.suggestion, props.class)}
    >
      {props.children}
      {props.closable && (
        <Button.Icon
          icon="close"
          class={styles.close}
          onClick={(e) => {
            cancelEvent(e);
            props.closable();
          }}
        />
      )}
    </Row>
  );
};

PendingSuggestion.Title = (props: Parameters<typeof Row.Title>[0]) => {
  return (
    <Row.Title {...props}>
      <span class={classNames('text-bold', styles.suggestionTitle)}>{props.children}</span>
    </Row.Title>
  );
};

PendingSuggestion.Subtitle = (props: Parameters<typeof Row.Subtitle>[0]) => {
  return (
    <Row.Subtitle {...props}>
      <span class={styles.suggestionSubtitle}>{props.children}</span>
    </Row.Subtitle>
  );
};

function FrozenSuggestion() {
  const [isSidebarCollapsed] = useIsSidebarCollapsed();
  const emoji = () => wrapEmojiText('🚫');

  const onClick = () => {
    showFrozenPopup();
  };

  return (
    <Show
      when={isSidebarCollapsed()}
      fallback={
        <PendingSuggestion
          class={styles.danger}
          clickable={onClick}
          color="danger"
        >
          <PendingSuggestion.Title>{i18n('Suggestion.Frozen.Title', [emoji()])}</PendingSuggestion.Title>
          <PendingSuggestion.Subtitle>{i18n('Suggestion.Frozen.Subtitle')}</PendingSuggestion.Subtitle>
        </PendingSuggestion>
      }
    >
      <RippleElement
        component="div"
        class={classNames(styles.collapsed, 'hover-danger-effect')}
        onClick={onClick}
      >
        {documentFragmentToNodes(emoji())}
      </RippleElement>
    </Show>
  );
}

function NotificationsSuggestion() {
  const [isSidebarCollapsed] = useIsSidebarCollapsed();
  const [appSettings, setAppSettings] = useAppSettings();
  const emoji = () => wrapEmojiText('🔔');

  const onDismissed = () => {
    setAppSettings('notifications', 'suggested', true);
    toastNew({langPackKey: 'Suggestion.Notifications.Dismissed'});

    // setTimeout(() => {
    //   setAppSettings('notifications', 'suggested', false);
    // }, 2e3);
  };

  const onClick = () => {
    Notification.requestPermission().then((permission) => {
      if(permission === 'granted') {
        setAppSettings('notifications', 'suggested', true);
        uiNotificationsManager.onPushConditionsChange();
      } else if(permission === 'denied') {
        throw 1;
      }
    }).catch(onDismissed);
  };

  return (
    <Show
      when={isSidebarCollapsed()}
      fallback={
        <PendingSuggestion
          class={styles.secondary}
          clickable={onClick}
          closable={onDismissed}
        >
          <PendingSuggestion.Title>
            {i18n('Suggestion.Notifications', [emoji()])}
          </PendingSuggestion.Title>
          <PendingSuggestion.Subtitle>
            {i18n('Suggestion.Notifications.Subtitle')}
          </PendingSuggestion.Subtitle>
        </PendingSuggestion>
      }
    >
      <RippleElement
        component="div"
        class={classNames(styles.collapsed, 'hover-effect')}
        onClick={onClick}
      >
        {documentFragmentToNodes(emoji())}
      </RippleElement>
    </Show>
  );
}

export function renderPendingSuggestion(toElement: HTMLElement) {
  toElement.classList.add(styles.container);

  render(() => {
    const [{appConfig}] = useAppState();
    const [appSettings, setAppSettings] = useAppSettings();
    const [element, setElement] = createSignal<JSX.Element>();

    // * test
    // onMount(() => {
    //   if(appSettings.notifications.suggested) {
    //     setAppSettings('notifications', 'suggested', false);
    //   }
    // });

    createEffect(() => {
      let element: JSX.Element;
      if(appConfig.freeze_since_date) {
        element = FrozenSuggestion();
      } else if(
        !appSettings.notifications.suggested &&
        Notification.permission !== 'granted'
      ) {
        element = NotificationsSuggestion();
      }

      if(element) {
        element = (<div class={styles.suggestionContainer}>{element}</div>)
      }

      setElement(element);
    });

    createEffect(() => {
      document.body.classList.toggle('has-pending-suggestion', !!element());
      // toElement.classList.toggle(styles.shown, !!element());
    });

    return (
      <Animated
        type="grow-height"
        appear
        mode="add-remove"
        noItemClass
      >
        {element()}
      </Animated>
    );
  }, toElement);
}
